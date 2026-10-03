#!/usr/bin/env python3
"""Deposit watcher — scan VaultKernel.Deposited and admit from pending_admit outbox.

Requires prior POST /screen with commitment + userSalt (stores PendingAdmit).
Then this watcher matches Deposited.commitment → derives label → POST /set/admit logic.

Usage:
  python scripts/watch_deposits.py --chain-id 31337 --once
  python scripts/watch_deposits.py --chain-id 31337 --loop
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
from web3 import Web3

load_dotenv()

import config
from association_set import admit_label, is_admitted
from chain_verify import DEPOSITED_ABI, DEPOSITED_TOPIC, verify_screen_admit_binding
from core.label import derive_deposit_label
from db import (
    META_METRIC_ADMITS,
    META_METRIC_WATCHER_ADMITS,
    bump_meta_counter,
    get_meta,
    init_db,
    session,
    set_meta,
    watcher_cursor_key,
    write_audit,
)
from pending_admit import get_pending_by_commitment, mark_pending_admitted, mark_pending_failed, read_pending_salt

log = logging.getLogger("aspv2.watcher")


def _w3(chain_id: int) -> Web3:
    url = config.rpc_url_for(chain_id) or config.RPC_URL
    if not url:
        raise RuntimeError(f"ASP_RPC_URL / ASP_RPC_URLS for chain {chain_id} required")
    return Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 30}))


def _vault(chain_id: int) -> str:
    addr = config.vault_kernel_address(chain_id)
    if not addr:
        raise RuntimeError(f"VAULT_KERNEL_{chain_id} required")
    return Web3.to_checksum_address(addr)


def poll_once(chain_id: int) -> dict:
    init_db()
    w3 = _w3(chain_id)
    vault = _vault(chain_id)
    latest = int(w3.eth.block_number)
    conf = max(0, config.CHAIN_MIN_CONFIRMATIONS)
    tip = max(0, latest - conf)

    with session() as db:
        cursor_key = watcher_cursor_key(chain_id)
        raw = get_meta(db, cursor_key)
        start = int(raw) + 1 if raw else max(0, tip - config.WATCHER_LOOKBACK_BLOCKS)
    # Catch up a bounded chunk per poll; the cursor below advances to this tip.
    tip = min(tip, start + config.WATCHER_MAX_RANGE - 1)

    if start > tip:
        return {"ok": True, "scanned": 0, "admitted": 0, "fromBlock": start, "toBlock": tip}

    event = w3.eth.contract(abi=DEPOSITED_ABI).events.Deposited()
    topic = DEPOSITED_TOPIC  # derived from DEPOSITED_ABI — see chain_verify
    logs = w3.eth.get_logs(
        {"fromBlock": start, "toBlock": tip, "address": vault, "topics": [topic]}
    )

    admitted = 0
    skipped = 0
    errors = 0
    for entry in logs:
        try:
            ev = event.process_log(entry)
            commitment = str(ev["args"]["commitment"])
            nonce = int(ev["args"]["depositNonce"])
            depositor = str(ev["args"]["depositor"]).lower()
            tx_hash = entry["transactionHash"].hex()
            if not tx_hash.startswith("0x"):
                tx_hash = "0x" + tx_hash

            with session() as db:
                pending = get_pending_by_commitment(db, chain_id, commitment)
                if not pending or pending.status != "pending" or not pending.user_salt:
                    skipped += 1
                    continue
                pend_dep = (pending.depositor or "").lower()
                if pend_dep and pend_dep != depositor:
                    mark_pending_failed(db, pending, "pending_depositor_mismatch")
                    db.commit()
                    errors += 1
                    continue
                try:
                    salt = int(read_pending_salt(pending))
                except ValueError as exc:
                    mark_pending_failed(db, pending, str(exc))
                    db.commit()
                    errors += 1
                    continue
                label = str(
                    derive_deposit_label(
                        chain_id=chain_id,
                        vault_address=vault,
                        deposit_nonce=nonce,
                        user_salt=salt,
                    )
                )
                if is_admitted(db, label):
                    mark_pending_admitted(db, pending, tx_hash=tx_hash, label=label)
                    db.commit()
                    skipped += 1
                    continue
                try:
                    verify_screen_admit_binding(
                        db,
                        commitment=commitment,
                        chain_id=chain_id,
                        tx_hash=tx_hash,
                        depositor=depositor,
                    )
                except ValueError as exc:
                    mark_pending_failed(db, pending, str(exc))
                    db.commit()
                    errors += 1
                    continue

                admit_label(
                    db,
                    label=label,
                    chain_id=chain_id,
                    vault_address=vault,
                    deposit_nonce=nonce,
                    depositor=depositor,
                    commitment=commitment,
                )
                mark_pending_admitted(db, pending, tx_hash=tx_hash, label=label)
                bump_meta_counter(db, META_METRIC_ADMITS)
                bump_meta_counter(db, META_METRIC_WATCHER_ADMITS)
                write_audit(
                    db,
                    action="watcher_admit",
                    payload={"label": label, "txHash": tx_hash, "commitment": commitment},
                )
                db.commit()
                admitted += 1
                log.info("admitted label leaf via watcher tx=%s…", tx_hash[:12])
        except Exception as exc:
            log.exception("watcher log failed: %s", exc)
            errors += 1

    with session() as db:
        set_meta(db, watcher_cursor_key(chain_id), str(tip))
        db.commit()

    return {
        "ok": True,
        "scanned": len(logs),
        "admitted": admitted,
        "skipped": skipped,
        "errors": errors,
        "fromBlock": start,
        "toBlock": tip,
    }


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="[watcher] %(levelname)s %(message)s")
    p = argparse.ArgumentParser(description="aspv2 deposit watcher")
    p.add_argument("--chain-id", type=int, required=True)
    p.add_argument("--once", action="store_true")
    p.add_argument("--loop", action="store_true")
    p.add_argument("--interval", type=int, default=None)
    args = p.parse_args()
    if args.loop or not args.once:
        interval = args.interval or config.WATCHER_INTERVAL
        while True:
            try:
                out = poll_once(args.chain_id)
                log.info("%s", out)
            except Exception:
                log.exception("poll failed")
            if args.once:
                break
            time.sleep(interval)
    else:
        print(poll_once(args.chain_id))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
