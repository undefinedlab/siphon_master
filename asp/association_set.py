"""ASP association set — append-only, PROTOCOL §2.6."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from core.asp_tree import AspTree, MerklePath, verify_inclusion
from core.poseidon import SNARK_SCALAR_FIELD
from solana_chain_ids import is_solana_chain_id
from db import (
    AspLabel,
    META_ADMITTED_LEAF_COUNT,
    META_ADMITTED_ROOT,
    META_ONCHAIN_ADMITTED_ROOT,
    META_PENDING_ADMIT_PUBLISH,
    get_meta,
    set_meta,
)

log = logging.getLogger("aspv2.association_set")

_POSTGRES_SET_LOCK_ID = 0x534950484F4E


def canonical_label(label: str | int) -> str:
    raw = str(label).strip().lower()
    if not raw:
        raise ValueError("label required")
    try:
        value = int(raw, 16) if raw.startswith("0x") else int(raw, 10)
    except ValueError as exc:
        raise ValueError("label must be decimal or 0x hex") from exc
    if value < 0 or value >= SNARK_SCALAR_FIELD:
        raise ValueError("label must be a BN254 scalar field element")
    return str(value)


def _lock_mutation(db: Session) -> None:
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _POSTGRES_SET_LOCK_ID})


def _load_labels_ordered(db: Session) -> list[int]:
    rows = db.execute(select(AspLabel).order_by(AspLabel.leaf_index.asc())).scalars().all()
    return [int(r.label) for r in rows]


def _rebuild_tree(db: Session) -> tuple[int, int]:
    labels = _load_labels_ordered(db)
    tree = AspTree()
    for lab in labels:
        tree.insert(lab)
    root = tree.root()
    set_meta(db, META_ADMITTED_ROOT, str(root))
    set_meta(db, META_ADMITTED_LEAF_COUNT, str(len(labels)))
    return root, len(labels)


def empty_admitted_root() -> str:
    return str(AspTree().root())


def current_admitted_root(db: Session) -> str:
    v = get_meta(db, META_ADMITTED_ROOT)
    if v:
        return v
    root, _ = _rebuild_tree(db)
    return str(root)


def admitted_leaf_count(db: Session) -> int:
    v = get_meta(db, META_ADMITTED_LEAF_COUNT)
    if v:
        return int(v)
    _, n = _rebuild_tree(db)
    return n


def is_admitted(db: Session, label: str | int) -> bool:
    try:
        lab = canonical_label(label)
    except ValueError:
        return False
    row = db.execute(select(AspLabel).where(AspLabel.label == lab)).scalar_one_or_none()
    return row is not None


def get_label_row(db: Session, label: str | int) -> AspLabel | None:
    try:
        lab = canonical_label(label)
    except ValueError:
        return None
    return db.execute(select(AspLabel).where(AspLabel.label == lab)).scalar_one_or_none()


@dataclass
class AspPathResponse:
    label: str
    root: str
    leaf_index: int
    path_elements: list[str]
    path_indices: list[int]


def get_admitted_path(db: Session, label: str | int) -> AspPathResponse | None:
    row = get_label_row(db, label)
    if not row:
        return None
    labels = _load_labels_ordered(db)
    tree = AspTree()
    for lab in labels:
        tree.insert(lab)

    # Build the WHOLE tree first, then take the path. Returning mid-replay (as this used to) yields
    # the path and root as of the target leaf's insertion, so every leaf except the most recently
    # admitted one served a stale witness — it reproduced a historical root and the spend died on
    # the circuit's AspInclusion root assert. Admitted funds became unspendable.
    try:
        root, path = tree.path_for_index(row.leaf_index)
    except IndexError:
        return None

    return AspPathResponse(
        label=row.label,
        root=str(root),
        leaf_index=row.leaf_index,
        path_elements=[str(x) for x in path.path_elements],
        path_indices=path.path_indices,
    )


def verify_label_in_root(db: Session, label: str | int, root: int | str | None = None) -> bool:
    path_resp = get_admitted_path(db, label)
    if not path_resp:
        return False
    want_root = int(root) if root is not None else int(path_resp.root)
    mp = MerklePath(
        [int(x) for x in path_resp.path_elements],
        path_resp.path_indices,
    )
    return verify_inclusion(int(path_resp.label), want_root, mp, path_resp.leaf_index)


def admit_label(
    db: Session,
    *,
    label: str | int,
    chain_id: int | None = None,
    vault_address: str | None = None,
    deposit_nonce: int | None = None,
    depositor: str | None = None,
    commitment: str | None = None,
    amount: str | int | None = None,
    asset_id: str | int | None = None,
) -> dict:
    """Append label to ASP tree (idempotent if already present)."""
    _lock_mutation(db)
    try:
        lab = canonical_label(label)
    except ValueError as exc:
        return {"admitted": False, "error": "invalid_label", "message": str(exc)}

    existing = db.execute(select(AspLabel).where(AspLabel.label == lab)).scalar_one_or_none()
    if existing:
        return {
            "admitted": False,
            "already": True,
            "label": lab,
            "leafIndex": existing.leaf_index,
            "root": current_admitted_root(db),
            "status": existing.status,
        }

    count = admitted_leaf_count(db)
    # EVM addresses are case-insensitive hex; Solana base58 pubkeys are case-sensitive.
    norm = (lambda v: v or None) if is_solana_chain_id(chain_id) else (lambda v: (v or "").lower() or None)
    db.add(
        AspLabel(
            label=lab,
            leaf_index=count,
            chain_id=chain_id,
            vault_address=norm(vault_address),
            deposit_nonce=deposit_nonce,
            depositor=norm(depositor),
            commitment=commitment,
            amount=(str(amount) if amount is not None else None),
            asset_id=(str(asset_id) if asset_id is not None else None),
            status="queued",
        )
    )
    db.flush()
    root, size = _rebuild_tree(db)
    set_meta(db, META_PENDING_ADMIT_PUBLISH, "1")
    log.info("admitted label leaf_index=%s root=%s…", count, str(root)[:20])
    return {
        "admitted": True,
        "already": False,
        "label": lab,
        "leafIndex": count,
        "root": str(root),
        "admittedLeafCount": size,
        "status": "queued",
    }


def mark_admitted_published(db: Session, published_root: str) -> None:
    """After on-chain publish, mark queued labels published."""
    import time

    from db import META_LAST_ADMIT_PUBLISH_TS

    rows = db.execute(select(AspLabel).where(AspLabel.status == "queued")).scalars().all()
    for row in rows:
        row.status = "published"
    set_meta(db, META_ONCHAIN_ADMITTED_ROOT, published_root)
    set_meta(db, META_PENDING_ADMIT_PUBLISH, "")
    set_meta(db, META_LAST_ADMIT_PUBLISH_TS, str(int(time.time())))


def set_snapshot(db: Session) -> dict:
    pending = get_meta(db, META_PENDING_ADMIT_PUBLISH) == "1"
    return {
        "setId": "screened",
        "admittedRoot": current_admitted_root(db),
        "admittedLeafCount": admitted_leaf_count(db),
        "pendingAdmitPublish": pending,
        "onchainAdmittedRoot": get_meta(db, META_ONCHAIN_ADMITTED_ROOT),
        "depth": 32,
    }
