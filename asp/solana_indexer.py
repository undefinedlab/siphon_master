"""siphon-vault-zk state-leaf indexer.

Every deposit and every spend touches the vault PDA (it is `mut` in both), so walking the
vault's signature history and decoding `DepositEvent` / `LeafInserted` yields every leaf of the
state tree. The cursor is the newest processed signature; each poll fetches only what is newer
(`until=cursor`) and applies it oldest-first.

`verify_against_chain` rebuilds the root from the stored leaves and compares it with the tree
account, so a gap (dropped RPC history, a missed tx) is reported instead of served.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from core.poseidon import hash2
from db import SolanaLeaf, clear_meta, get_meta, set_meta
from solana_chain_ids import SOLANA_DEVNET_CHAIN_ID
from solana_rpc import LeafEvent, SolanaRpc, decode_leaf_events, le_to_field

log = logging.getLogger("aspv2.solana_indexer")

STATE_TREE_DEPTH = 32
# TreeAccount (zero-copy, after the 8-byte Anchor discriminator):
#   bump u8, recent_len u8, recent_head u8, _pad0 [u8;5], next_index u64, root [u8;32], ...
_TREE_NEXT_INDEX = slice(16, 24)
_TREE_ROOT = slice(24, 56)


def _pubkey(value: str):
    from solders.pubkey import Pubkey

    return Pubkey.from_string(value)


def zk_program_id() -> str:
    pid = os.getenv("SOLANA_ZK_PROGRAM_ID", "").strip()
    if not pid:
        raise RuntimeError("SOLANA_ZK_PROGRAM_ID required")
    return pid


def pda(seed: bytes, program_id: str | None = None) -> str:
    from solders.pubkey import Pubkey

    key, _ = Pubkey.find_program_address([seed], _pubkey(program_id or zk_program_id()))
    return str(key)


def vault_pda(program_id: str | None = None) -> str:
    return pda(b"siphon-vault-v1", program_id)


def tree_pda(program_id: str | None = None) -> str:
    return pda(b"siphon-tree-v1", program_id)


def _cursor_key(chain_id: int) -> str:
    return f"solana_indexer_cursor_{chain_id}"


def _store(db: Session, chain_id: int, ev: LeafEvent) -> bool:
    existing = db.execute(
        select(SolanaLeaf).where(SolanaLeaf.chain_id == chain_id, SolanaLeaf.leaf_index == ev.leaf_index)
    ).scalar_one_or_none()
    if existing:
        if existing.commitment != ev.commitment:
            # Same index, different leaf: the program never reuses an index, so this is a
            # program redeploy/reinit against a stale DB. Refuse rather than serve a forked tree.
            raise RuntimeError(
                f"leaf {ev.leaf_index} conflict: stored {existing.commitment[:16]}… vs chain {ev.commitment[:16]}…"
            )
        return False
    db.add(
        SolanaLeaf(
            chain_id=chain_id,
            leaf_index=ev.leaf_index,
            commitment=ev.commitment,
            kind=ev.kind,
            depositor=ev.depositor,
            mint=ev.mint,
            deposit_nonce=ev.deposit_nonce,
            signature=ev.signature,
            slot=ev.slot,
        )
    )
    return True


def _ingest_signatures(
    db: Session,
    rpc: SolanaRpc,
    sigs: list[dict],
    *,
    chain_id: int,
    stop_on_missing_tx: bool,
) -> tuple[int, int]:
    """Decode vault txs oldest-first. Returns (storedLeaves, skippedMissingTx)."""
    stored = 0
    skipped = 0
    for item in reversed(sigs):
        if item.get("err"):
            continue
        tx = rpc.transaction(item["signature"])
        if not tx:
            skipped += 1
            if stop_on_missing_tx:
                # Incremental poll: do not advance the cursor past a gap we have not decoded.
                log.warning("tx %s not available yet; retrying next poll", item["signature"][:12])
                break
            log.warning("tx %s unavailable during backfill — continuing", item["signature"][:12])
            continue
        events = decode_leaf_events(
            (tx.get("meta") or {}).get("logMessages") or [],
            signature=item["signature"],
            slot=int(tx.get("slot") or item.get("slot") or 0),
        )
        for ev in events:
            stored += int(_store(db, chain_id, ev))
        set_meta(db, _cursor_key(chain_id), item["signature"])
        db.commit()
    return stored, skipped


def poll_once(db: Session, rpc: SolanaRpc, *, chain_id: int = SOLANA_DEVNET_CHAIN_ID) -> dict:
    vault = vault_pda()
    cursor = get_meta(db, _cursor_key(chain_id))

    new_sigs: list[dict] = []
    before: str | None = None
    while True:
        page = rpc.signatures_for_address(vault, before=before, until=cursor, limit=1000)
        new_sigs.extend(page)
        if len(page) < 1000:
            break
        before = page[-1]["signature"]

    stored, _skipped = _ingest_signatures(db, rpc, new_sigs, chain_id=chain_id, stop_on_missing_tx=True)

    count = db.execute(
        select(func.count()).select_from(SolanaLeaf).where(SolanaLeaf.chain_id == chain_id)
    ).scalar_one()
    return {"ok": True, "newSignatures": len(new_sigs), "storedLeaves": stored, "leafCount": int(count)}


# Anchor LeafIndexAccount: 8-byte disc + bump u8 + leaf_index u64.
_LEAF_ACCOUNT_SIZE = 8 + 1 + 8
_LEAF_ACCOUNT_DISC = hashlib.sha256(b"account:LeafIndexAccount").digest()[:8]


def reset_solana_leaf_index(db: Session, *, chain_id: int) -> None:
    """Drop indexed leaves after a vault reinit/redeploy (same leaf_index, new commitment)."""
    deleted = db.execute(delete(SolanaLeaf).where(SolanaLeaf.chain_id == chain_id)).rowcount
    clear_meta(db, _cursor_key(chain_id))
    db.commit()
    log.warning("reset solana_leaf index for chain %s (%s rows) — vault fork/redeploy", chain_id, deleted)


def backfill_leaves(
    db: Session,
    rpc: SolanaRpc,
    *,
    chain_id: int = SOLANA_DEVNET_CHAIN_ID,
    _retried: bool = False,
) -> dict:
    """Heal gaps via LeafIndexAccount PDAs (default) — not a full vault-history walk.

    Public Devnet RPC 429s on ~189 getTransaction calls over vault signatures. Each leaf has a
    PDA; listing those (one getProgramAccounts) and fetching each PDA's create tx (~2N calls)
    fills the same events and stays under rate limits. `_store` is idempotent. On leaf-index
    conflict (stale DB vs live vault), reset once and retry.
    """
    try:
        program_id = zk_program_id()
        accounts = rpc.program_accounts(program_id, data_size=_LEAF_ACCOUNT_SIZE)
        stored = 0
        skipped = 0
        create_sigs: list[str] = []

        for item in accounts:
            pubkey = item.get("pubkey") or ""
            raw_b64 = ((item.get("account") or {}).get("data") or [None])[0]
            if not pubkey or not raw_b64:
                skipped += 1
                continue
            data = base64.b64decode(raw_b64)
            if len(data) < _LEAF_ACCOUNT_SIZE or data[:8] != _LEAF_ACCOUNT_DISC:
                continue
            sigs = rpc.signatures_for_address(pubkey, limit=5)
            if not sigs:
                skipped += 1
                continue
            # Newest-first; create is the oldest that still touches this PDA.
            create_sig = sigs[-1]["signature"]
            create_sigs.append(create_sig)
            tx = rpc.transaction(create_sig)
            if not tx:
                skipped += 1
                continue
            events = decode_leaf_events(
                (tx.get("meta") or {}).get("logMessages") or [],
                signature=create_sig,
                slot=int(tx.get("slot") or sigs[-1].get("slot") or 0),
            )
            for ev in events:
                stored += int(_store(db, chain_id, ev))
            db.commit()

        if create_sigs:
            # Newest vault activity for incremental poll — best-effort from leaf creates.
            set_meta(db, _cursor_key(chain_id), create_sigs[0])
            db.commit()

        count = db.execute(
            select(func.count()).select_from(SolanaLeaf).where(SolanaLeaf.chain_id == chain_id)
        ).scalar_one()
        log.info(
            "backfill chain=%s leafAccounts=%s stored=%s skipped=%s leafCount=%s",
            chain_id,
            len(accounts),
            stored,
            skipped,
            count,
        )
        return {
            "ok": True,
            "backfilled": True,
            "leafAccounts": len(accounts),
            "storedLeaves": stored,
            "skippedMissingTx": skipped,
            "leafCount": int(count),
            "reset": _retried,
        }
    except RuntimeError as exc:
        if _retried or "conflict" not in str(exc):
            raise
        log.warning("backfill conflict — resetting leaf index and retrying once: %s", exc)
        db.rollback()
        reset_solana_leaf_index(db, chain_id=chain_id)
        return backfill_leaves(db, rpc, chain_id=chain_id, _retried=True)


def ensure_leaves(
    db: Session,
    rpc: SolanaRpc,
    *,
    chain_id: int = SOLANA_DEVNET_CHAIN_ID,
) -> dict:
    """Verify; on incomplete/root mismatch, backfill once and re-verify. Default path for serving."""
    check = verify_against_chain(db, rpc, chain_id=chain_id)
    if check.get("ok"):
        return {**check, "backfilled": False}
    err = check.get("error")
    if err not in ("leaves_incomplete", "root_mismatch"):
        return {**check, "backfilled": False}
    log.warning(
        "state leaves out of sync (%s indexed=%s nextIndex=%s) — backfilling",
        err,
        check.get("indexed"),
        check.get("nextIndex"),
    )
    bf = backfill_leaves(db, rpc, chain_id=chain_id)
    check2 = verify_against_chain(db, rpc, chain_id=chain_id)
    return {**check2, "backfilled": True, "backfill": bf}


def ordered_leaves(db: Session, *, chain_id: int = SOLANA_DEVNET_CHAIN_ID) -> list[SolanaLeaf]:
    return list(
        db.execute(
            select(SolanaLeaf).where(SolanaLeaf.chain_id == chain_id).order_by(SolanaLeaf.leaf_index.asc())
        ).scalars()
    )


def compute_root(commitments: list[int]) -> int:
    zeros = [0]
    for _ in range(STATE_TREE_DEPTH):
        zeros.append(hash2(zeros[-1], zeros[-1]))
    level = list(commitments)
    for d in range(STATE_TREE_DEPTH):
        if not level:
            level = [zeros[d + 1]]
            continue
        nxt = []
        for i in range(0, len(level), 2):
            right = level[i + 1] if i + 1 < len(level) else zeros[d]
            nxt.append(hash2(level[i], right))
        level = nxt
    return level[0]


def verify_against_chain(db: Session, rpc: SolanaRpc, *, chain_id: int = SOLANA_DEVNET_CHAIN_ID) -> dict:
    """Leaves must be contiguous 0..n-1, n must equal tree.next_index, and the root must match."""
    rows = ordered_leaves(db, chain_id=chain_id)
    data = rpc.account_data(tree_pda())
    if not data:
        return {"ok": False, "error": "tree_account_missing"}
    next_index = int.from_bytes(data[_TREE_NEXT_INDEX], "little")
    chain_root = le_to_field(data[_TREE_ROOT])
    gaps = [i for i, r in enumerate(rows) if r.leaf_index != i]
    if gaps or len(rows) != next_index:
        return {
            "ok": False,
            "error": "leaves_incomplete",
            "indexed": len(rows),
            "nextIndex": next_index,
            "firstGap": gaps[0] if gaps else len(rows),
        }
    root = compute_root([int(r.commitment) for r in rows])
    return {
        "ok": root == chain_root,
        "error": None if root == chain_root else "root_mismatch",
        "root": str(root),
        "chainRoot": str(chain_root),
        "leafCount": len(rows),
    }
