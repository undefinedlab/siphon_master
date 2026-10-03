#!/usr/bin/env python3
"""Solana deposit watcher — index siphon-vault-zk leaves, admit deposits from the pending outbox.

Same admission rules as the EVM watcher (scripts/watch_deposits.py):
  POST /screen (commitment + userSalt + depositor) → PendingAdmit
  DepositEvent(commitment, depositor, nonce) → label = mintLabelSalted(scope_sol, nonce, salt)
  → screen decision must be `admit` for this depositor → admit_label.

Unlike the EVM watcher, an unmatched deposit is not skipped for good: its leaf keeps
admit_status NULL and is retried every poll, so a screen that lands after the deposit
confirms still admits.

Usage:
  python scripts/watch_deposits_solana.py --once
  python scripts/watch_deposits_solana.py --loop
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv()

from sqlalchemy import select

import config
from association_set import admit_label, is_admitted
from chain_verify import verify_screen_admit_binding
from core.label import derive_deposit_label
from db import (
    META_METRIC_ADMITS,
    META_METRIC_WATCHER_ADMITS,
    SolanaLeaf,
    bump_meta_counter,
    init_db,
    session,
    write_audit,
)
from pending_admit import get_pending_by_commitment, mark_pending_admitted, mark_pending_failed, read_pending_salt
from solana_chain_ids import SOLANA_DEVNET_CHAIN_ID
from solana_indexer import ensure_leaves
from solana_indexer import poll_once as index_once
from solana_indexer import vault_pda, zk_program_id
from solana_rpc import SolanaRpc

log = logging.getLogger("aspv2.solana_watcher")


def admit_pending(db, *, chain_id: int) -> dict:
    program_id = zk_program_id()
    vault = vault_pda(program_id)
    rows = db.execute(
        select(SolanaLeaf)
        .where(
            SolanaLeaf.chain_id == chain_id,
            SolanaLeaf.kind == "deposit",
            SolanaLeaf.admit_status.is_(None),
        )
        .order_by(SolanaLeaf.leaf_index.asc())
    ).scalars().all()

    admitted = waiting = errors = 0
    for leaf in rows:
        pending = get_pending_by_commitment(db, chain_id, leaf.commitment)
        if not pending or pending.status != "pending" or not pending.user_salt:
            waiting += 1
            continue
        if pending.depositor and pending.depositor != leaf.depositor:
            mark_pending_failed(db, pending, "pending_depositor_mismatch")
            leaf.admit_status = "failed"
            db.commit()
            errors += 1
            continue
        try:
            salt = int(read_pending_salt(pending))
            label = str(
                derive_deposit_label(
                    chain_id=chain_id,
                    vault_address=vault,
                    deposit_nonce=int(leaf.deposit_nonce),
                    user_salt=salt,
                    program_id=program_id,
                )
            )
        except ValueError as exc:
            mark_pending_failed(db, pending, str(exc))
            leaf.admit_status = "failed"
            db.commit()
            errors += 1
            continue

        if is_admitted(db, label):
            mark_pending_admitted(db, pending, tx_hash=leaf.signature, label=label)
            leaf.admit_status = "admitted"
            db.commit()
            continue
        try:
            verify_screen_admit_binding(
                db,
                commitment=leaf.commitment,
                chain_id=chain_id,
                tx_hash=leaf.signature,
                depositor=leaf.depositor,
            )
        except ValueError as exc:
            mark_pending_failed(db, pending, str(exc))
            leaf.admit_status = "failed"
            db.commit()
            errors += 1
            continue

        admit_label(
            db,
            label=label,
            chain_id=chain_id,
            vault_address=vault,
            deposit_nonce=int(leaf.deposit_nonce),
            depositor=leaf.depositor,
            commitment=leaf.commitment,
        )
        mark_pending_admitted(db, pending, tx_hash=leaf.signature, label=label)
        leaf.admit_status = "admitted"
        bump_meta_counter(db, META_METRIC_ADMITS)
        bump_meta_counter(db, META_METRIC_WATCHER_ADMITS)
        write_audit(
            db,
            action="watcher_admit_solana",
            payload={"label": label, "signature": leaf.signature, "commitment": leaf.commitment},
        )
        db.commit()
        admitted += 1
        log.info("admitted leaf %s sig=%s…", leaf.leaf_index, leaf.signature[:12])
    return {"admitted": admitted, "waitingForScreen": waiting, "errors": errors}


def poll_once(chain_id: int = SOLANA_DEVNET_CHAIN_ID) -> dict:
    init_db()
    rpc = SolanaRpc()
    with session() as db:
        idx = index_once(db, rpc, chain_id=chain_id)
        # Gaps from a prior cursor skip must not linger — heal before admit/serve.
        sync = ensure_leaves(db, rpc, chain_id=chain_id)
        adm = admit_pending(db, chain_id=chain_id)
    return {
        **idx,
        **adm,
        "leavesOk": bool(sync.get("ok")),
        "leavesBackfilled": bool(sync.get("backfilled")),
        "leafCount": sync.get("leafCount") or sync.get("backfill", {}).get("leafCount"),
    }


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="[watcher-sol] %(levelname)s %(message)s")
    p = argparse.ArgumentParser(description="aspv2 Solana deposit watcher")
    p.add_argument("--chain-id", type=int, default=SOLANA_DEVNET_CHAIN_ID)
    p.add_argument("--once", action="store_true")
    p.add_argument("--loop", action="store_true")
    p.add_argument(
        "--backfill",
        action="store_true",
        help="Force a full vault-history leaf backfill, then exit (heals leaves_incomplete).",
    )
    p.add_argument("--interval", type=int, default=None)
    args = p.parse_args()
    if args.backfill:
        init_db()
        from solana_indexer import backfill_leaves, ensure_leaves

        rpc = SolanaRpc()
        with session() as db:
            bf = backfill_leaves(db, rpc, chain_id=args.chain_id)
            sync = ensure_leaves(db, rpc, chain_id=args.chain_id)
        print({**bf, "leavesOk": bool(sync.get("ok")), "root": sync.get("root")})
        return 0 if sync.get("ok") else 1
    if not args.loop:
        print(poll_once(args.chain_id))
        return 0
    interval = args.interval or config.WATCHER_INTERVAL
    while True:
        try:
            log.info("%s", poll_once(args.chain_id))
        except Exception:
            log.exception("poll failed")
        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
