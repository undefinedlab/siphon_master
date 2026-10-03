"""Revocation SMT — PROTOCOL §2.5 (append-only; ASP tree not evicted)."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from core.smt import (
    build_empty_subtrees,
    empty_leaf,
    inclusion_path,
    non_inclusion_path,
    revoked_tree_root,
    verify_inclusion,
    verify_non_inclusion,
)
from core.domains import load_domains, smt_key, smt_leaf_hash
from core.poseidon import SNARK_SCALAR_FIELD
from db import (
    META_ONCHAIN_REVOKED_ROOT,
    META_PENDING_REVOKE_PUBLISH,
    META_REVOKED_ROOT,
    RevokedLabel,
    get_meta,
    set_meta,
)

log = logging.getLogger("aspv2.revocation_set")

_POSTGRES_REVOKE_LOCK_ID = 0x5245564F4B45  # "REVOKE"


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
        db.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _POSTGRES_REVOKE_LOCK_ID})


def _load_revoked_labels(db: Session) -> list[int]:
    rows = db.execute(select(RevokedLabel).order_by(RevokedLabel.id.asc())).scalars().all()
    return [int(r.label) for r in rows]


def empty_revoked_root() -> str:
    empty = build_empty_subtrees()
    return str(empty[32])


def current_revoked_root(db: Session) -> str:
    v = get_meta(db, META_REVOKED_ROOT)
    if v:
        return v
    labels = _load_revoked_labels(db)
    root = revoked_tree_root(labels)
    set_meta(db, META_REVOKED_ROOT, str(root))
    return str(root)


def is_revoked(db: Session, label: str | int) -> bool:
    try:
        lab = canonical_label(label)
    except ValueError:
        return False
    row = db.execute(select(RevokedLabel).where(RevokedLabel.label == lab)).scalar_one_or_none()
    return row is not None


@dataclass
class SmtPathResponse:
    label: str
    root: str
    path_elements: list[str]
    path_indices: list[int]
    claimed_leaf: str


def get_smt_non_inclusion_path(db: Session, label: str | int) -> SmtPathResponse | None:
    try:
        lab_int = int(canonical_label(label))
    except ValueError:
        return None
    revoked = _load_revoked_labels(db)
    root, path, claimed = non_inclusion_path(lab_int, revoked)
    return SmtPathResponse(
        label=str(lab_int),
        root=str(root),
        path_elements=[str(x) for x in path.path_elements],
        path_indices=path.path_indices,
        claimed_leaf=str(claimed),
    )


def get_smt_inclusion_path(db: Session, label: str | int) -> SmtPathResponse | None:
    try:
        lab = canonical_label(label)
        lab_int = int(lab)
    except ValueError:
        return None
    if not is_revoked(db, lab):
        return None
    revoked = _load_revoked_labels(db)
    if lab_int not in revoked:
        return None
    built = inclusion_path(lab_int, revoked)
    if built is None:
        return None
    root, path = built
    domains = load_domains()
    leaf = smt_leaf_hash(lab_int, domains["DOMAIN_SMT_LEAF"])
    return SmtPathResponse(
        label=lab,
        root=str(root),
        path_elements=[str(x) for x in path.path_elements],
        path_indices=path.path_indices,
        claimed_leaf=str(leaf),
    )


def revoke_label(db: Session, *, label: str | int, reason: str | None = None) -> dict:
    _lock_mutation(db)
    try:
        lab = canonical_label(label)
    except ValueError as exc:
        return {"revoked": False, "error": "invalid_label", "message": str(exc)}

    existing = db.execute(select(RevokedLabel).where(RevokedLabel.label == lab)).scalar_one_or_none()
    if existing:
        return {
            "revoked": False,
            "already": True,
            "label": lab,
            "root": current_revoked_root(db),
        }

    db.add(RevokedLabel(label=lab, reason=reason))
    db.flush()
    revoked = _load_revoked_labels(db)
    root = str(revoked_tree_root(revoked))
    set_meta(db, META_REVOKED_ROOT, root)
    set_meta(db, META_PENDING_REVOKE_PUBLISH, "1")
    log.info("revoked label root=%s…", root[:20])
    return {"revoked": True, "already": False, "label": lab, "root": root}


def mark_revoked_published(db: Session, published_root: str) -> None:
    set_meta(db, META_ONCHAIN_REVOKED_ROOT, published_root)
    set_meta(db, META_PENDING_REVOKE_PUBLISH, "")


def dual_root_snapshot(db: Session) -> dict:
    from association_set import set_snapshot

    asp = set_snapshot(db)
    return {
        **asp,
        "revokedRoot": current_revoked_root(db),
        "pendingRevokePublish": get_meta(db, META_PENDING_REVOKE_PUBLISH) == "1",
        "onchainRevokedRoot": get_meta(db, META_ONCHAIN_REVOKED_ROOT),
    }
