"""Postman — publish admittedRoot / revokedRoot to ComplianceHub (v2)."""
from __future__ import annotations

import argparse
import json
import logging
import os
import time

from dotenv import load_dotenv
from web3 import Web3

import config
from association_set import current_admitted_root, mark_admitted_published
from chain_verify import assert_postman_key_matches_chain, read_onchain_roots
from db import (
    META_PENDING_ADMIT_PUBLISH,
    META_PENDING_REVOKE_PUBLISH,
    get_meta,
    init_db,
    session,
    set_meta,
    write_audit,
)
from revocation_set import current_revoked_root, dual_root_snapshot, mark_revoked_published

load_dotenv()
log = logging.getLogger("aspv2.postman")

COMPLIANCE_HUB_ABI = [
    {
        "inputs": [{"internalType": "uint256", "name": "newRoot", "type": "uint256"}],
        "name": "updateAdmittedRoot",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [{"internalType": "uint256", "name": "newRoot", "type": "uint256"}],
        "name": "updateRevokedRoot",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "admittedRoot",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "revokedRoot",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "postman",
        "outputs": [{"internalType": "address", "name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "admitEpochSeconds",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "lastAdmitPublish",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
]


def _w3(chain_id: int | None = None) -> Web3:
    url = config.rpc_url_for(chain_id) if chain_id else None
    url = url or config.RPC_URL or os.getenv("ASP_POSTMAN_RPC") or ""
    if not url:
        raise RuntimeError("ASP_RPC_URL or ASP_POSTMAN_RPC required")
    return Web3(Web3.HTTPProvider(url))


def _account(w3: Web3, chain_id: int | None = None):
    # Per-chain: each hub has its own postman, and _guard_postman below asserts this key's address
    # matches the on-chain one. A single key could only ever publish for one chain.
    pk = config.postman_key(chain_id)
    if not pk:
        raise RuntimeError(
            f"ASP_POSTMAN_KEY_{chain_id} (or ASP_POSTMAN_KEY) required" if chain_id
            else "ASP_POSTMAN_KEY required"
        )
    return w3.eth.account.from_key(pk)


def _hub(w3: Web3, chain_id: int | None = None):
    cid = chain_id if chain_id is not None else int(w3.eth.chain_id)
    addr = config.compliance_hub_address(cid)
    if not addr:
        raise RuntimeError(
            f"ComplianceHub address required "
            f"(ASP_COMPLIANCE_HUB_{cid} or COMPLIANCE_HUB_{cid} or COMPLIANCE_HUB_ADDRESS)"
        )
    return w3.eth.contract(address=Web3.to_checksum_address(addr), abi=COMPLIANCE_HUB_ABI)


def _guard_postman(w3: Web3, acct, chain_id: int | None = None) -> None:
    cid = chain_id if chain_id is not None else int(w3.eth.chain_id)
    assert_postman_key_matches_chain(acct.address, cid)
    # Per-chain, matching config.postman_key: each hub has its own postman, so pinning every chain
    # against one address rejects the correct key for all but one of them.
    pinned = config.postman_address(cid)
    if pinned and pinned != acct.address.lower():
        raise RuntimeError(
            f"ASP_POSTMAN_ADDRESS_{cid} (or ASP_POSTMAN_ADDRESS) {pinned} ≠ key {acct.address.lower()}"
        )


def _send(w3: Web3, acct, fn_call, gas: int) -> dict:
    # Simulate first: a fixed gas limit skips estimation, so a root the hub refuses
    # (AdmitRootReused / RevokeRootReused, e.g. after an ASP DB rebuild) used to cost a reverted
    # tx on every loop tick. A failing eth_call raises here and nothing is signed.
    fn_call.call({"from": acct.address})
    tx = fn_call.build_transaction(
        {
            "from": acct.address,
            "nonce": w3.eth.get_transaction_count(acct.address, "pending"),
            "chainId": w3.eth.chain_id,
            "gas": gas,
        }
    )
    if "maxFeePerGas" not in tx and "gasPrice" not in tx:
        try:
            tip = w3.eth.max_priority_fee
            base = w3.eth.get_block("latest")["baseFeePerGas"]
            tx["maxPriorityFeePerGas"] = tip
            tx["maxFeePerGas"] = base * 2 + tip
        except Exception:
            tx["gasPrice"] = w3.eth.gas_price
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "rawTransaction", None) or signed.raw_transaction
    tx_hash = w3.eth.send_raw_transaction(raw)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    if receipt.status != 1:
        raise RuntimeError(f"postman transaction reverted: {tx_hash.hex()}")
    return {"ok": True, "txHash": tx_hash.hex(), "blockNumber": receipt.blockNumber}


def publish_admitted_root(*, chain_id: int | None = None, dry_run: bool = False) -> dict:
    init_db()
    with session() as db:
        root = int(current_admitted_root(db))
    if dry_run:
        return {"dryRun": True, "admittedRoot": str(root)}

    w3 = _w3(chain_id)
    cid = chain_id if chain_id is not None else int(w3.eth.chain_id)
    acct = _account(w3, cid)
    hub = _hub(w3, cid)
    _guard_postman(w3, acct, cid)

    live = int(hub.functions.admittedRoot().call())
    if live == root:
        with session() as db:
            mark_admitted_published(db, str(root))
            db.commit()
        return {"skipped": True, "reason": "matches_chain", "admittedRoot": str(root)}

    # Pre-check epoch gate (ComplianceHub.AdmitEpoch) to avoid wasted reverting txs.
    try:
        epoch = int(hub.functions.admitEpochSeconds().call())
        last = int(hub.functions.lastAdmitPublish().call())
        now = int(w3.eth.get_block("latest")["timestamp"])
        if live != 0 and epoch > 0 and last > 0 and now < last + epoch:
            wait = last + epoch - now
            return {
                "skipped": True,
                "reason": "admit_epoch",
                "waitSeconds": wait,
                "admittedRoot": str(root),
                "onchainAdmittedRoot": str(live),
            }
    except Exception as exc:
        log.warning("admit epoch pre-check failed (continuing): %s", exc)

    out = _send(w3, acct, hub.functions.updateAdmittedRoot(root), 200_000)
    with session() as db:
        mark_admitted_published(db, str(root))
        write_audit(
            db,
            action="postman_updateAdmittedRoot",
            payload={"root": str(root), "tx": out["txHash"]},
            actor=acct.address,
        )
        db.commit()
    return {**out, "admittedRoot": str(root)}


def publish_revoked_root(*, chain_id: int | None = None, dry_run: bool = False) -> dict:
    init_db()
    with session() as db:
        root = int(current_revoked_root(db))
    if dry_run:
        return {"dryRun": True, "revokedRoot": str(root)}

    w3 = _w3(chain_id)
    cid = chain_id if chain_id is not None else int(w3.eth.chain_id)
    acct = _account(w3, cid)
    hub = _hub(w3, cid)
    _guard_postman(w3, acct, cid)

    live = int(hub.functions.revokedRoot().call())
    if live == root:
        with session() as db:
            mark_revoked_published(db, str(root))
            db.commit()
        return {"skipped": True, "reason": "matches_chain", "revokedRoot": str(root)}

    out = _send(w3, acct, hub.functions.updateRevokedRoot(root), 200_000)
    with session() as db:
        mark_revoked_published(db, str(root))
        write_audit(
            db,
            action="postman_updateRevokedRoot",
            payload={"root": str(root), "tx": out["txHash"]},
            actor=acct.address,
        )
        db.commit()
    return {**out, "revokedRoot": str(root)}


def publish_pending(*, chain_id: int | None = None, dry_run: bool = False) -> dict:
    """Publish any pending admit and/or revoke roots."""
    init_db()
    results: dict = {}
    with session() as db:
        need_admit = get_meta(db, META_PENDING_ADMIT_PUBLISH) == "1"
        need_revoke = get_meta(db, META_PENDING_REVOKE_PUBLISH) == "1"
    if need_revoke:
        results["revoked"] = publish_revoked_root(chain_id=chain_id, dry_run=dry_run)
    if need_admit:
        results["admitted"] = publish_admitted_root(chain_id=chain_id, dry_run=dry_run)
    if not results:
        return {"skipped": True, "reason": "nothing_pending"}
    return results


def reconcile(*, chain_id: int | None = None) -> dict:
    """Sync on-chain roots into MetaKV; flag drift; publish pending if behind."""
    init_db()
    onchain = read_onchain_roots(chain_id)
    with session() as db:
        snap = dual_root_snapshot(db)
        if not onchain:
            return {"ok": False, "error": "onchain_unavailable", "offchain": snap}
        drift_a = snap["admittedRoot"] != onchain.get("admittedRoot")
        drift_r = snap["revokedRoot"] != onchain.get("revokedRoot")
        from db import META_DRIFT_ADMITTED, META_DRIFT_REVOKED, META_ONCHAIN_ADMITTED_ROOT, META_ONCHAIN_REVOKED_ROOT

        set_meta(db, META_ONCHAIN_ADMITTED_ROOT, str(onchain.get("admittedRoot")))
        set_meta(db, META_ONCHAIN_REVOKED_ROOT, str(onchain.get("revokedRoot")))
        set_meta(db, META_DRIFT_ADMITTED, "1" if drift_a else "0")
        set_meta(db, META_DRIFT_REVOKED, "1" if drift_r else "0")
        # If off-chain matches chain but pending flags stuck, clear them.
        if not drift_a and get_meta(db, META_PENDING_ADMIT_PUBLISH) == "1":
            mark_admitted_published(db, snap["admittedRoot"])
        if not drift_r and get_meta(db, META_PENDING_REVOKE_PUBLISH) == "1":
            mark_revoked_published(db, snap["revokedRoot"])
        db.commit()

    publish_out = None
    if drift_a or drift_r:
        # Off-chain ahead of chain — publish the drifted root DIRECTLY, not via publish_pending.
        #
        # publish_pending is gated on META_PENDING_ADMIT_PUBLISH / META_PENDING_REVOKE_PUBLISH,
        # and those flags are global, not per-chain. With two chains that deadlocks: Sepolia
        # reconciles, sees no drift, and clears the shared flags (the branch above); Base then
        # reconciles, sees real drift, calls publish_pending — and is told "nothing_pending". Base's
        # hub sits at root 0 forever while the ASP believes it published, so no Base spend can ever
        # prove a path.
        #
        # Drift is ground truth; the flags are only an optimisation to skip redundant work. Both
        # publishers already no-op with "matches_chain" when the live root equals ours, so calling
        # them on every drifting tick costs a read, not a transaction — and the admit epoch gate
        # still applies.
        publish_out = {}
        if drift_r:
            publish_out["revoked"] = publish_revoked_root(chain_id=chain_id)
        if drift_a:
            publish_out["admitted"] = publish_admitted_root(chain_id=chain_id)
    return {
        "ok": True,
        "drift": {"admitted": drift_a, "revoked": drift_r},
        "offchain": {"admittedRoot": snap["admittedRoot"], "revokedRoot": snap["revokedRoot"]},
        "onchain": onchain,
        "publish": publish_out,
    }


def loop(interval_sec: int | None = None, chain_id: int | None = None) -> None:
    interval = interval_sec or config.POSTMAN_INTERVAL
    log.info("postman loop interval=%ss", interval)
    while True:
        try:
            out = publish_pending(chain_id=chain_id)
            log.info("publish: %s", json.dumps(out))
            rec = reconcile(chain_id=chain_id)
            if rec.get("drift", {}).get("admitted") or rec.get("drift", {}).get("revoked"):
                log.warning("drift: %s", json.dumps(rec.get("drift")))
        except Exception:
            log.exception("publish failed")
        time.sleep(interval)


def status(chain_id: int | None = None) -> dict:
    init_db()
    with session() as db:
        snap = dual_root_snapshot(db)
    onchain = read_onchain_roots(chain_id)
    w3 = _w3(chain_id)
    hub = _hub(w3, chain_id or int(w3.eth.chain_id))
    drift = None
    if onchain:
        drift = {
            "admitted": snap["admittedRoot"] != onchain.get("admittedRoot"),
            "revoked": snap["revokedRoot"] != onchain.get("revokedRoot"),
        }
    return {
        **snap,
        "onchain": onchain,
        "drift": drift,
        "hubPostman": hub.functions.postman().call(),
        "admitEpochSeconds": hub.functions.admitEpochSeconds().call(),
        "lastAdmitPublish": hub.functions.lastAdmitPublish().call(),
    }


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="[postman] %(levelname)s %(message)s")
    p = argparse.ArgumentParser(description="Siphon aspv2 ComplianceHub postman")
    p.add_argument(
        "cmd",
        choices=["publish", "publish-admitted", "publish-revoked", "loop", "status", "reconcile"],
        nargs="?",
        default="publish",
    )
    p.add_argument("--chain-id", type=int, default=None)
    p.add_argument("--interval", type=int, default=config.POSTMAN_INTERVAL)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    if args.cmd == "status":
        print(json.dumps(status(args.chain_id), indent=2, default=str))
        return
    if args.cmd == "reconcile":
        print(json.dumps(reconcile(chain_id=args.chain_id), indent=2, default=str))
        return
    if args.cmd == "loop":
        loop(args.interval, args.chain_id)
        return
    if args.cmd == "publish-admitted":
        print(json.dumps(publish_admitted_root(chain_id=args.chain_id, dry_run=args.dry_run), indent=2))
        return
    if args.cmd == "publish-revoked":
        print(json.dumps(publish_revoked_root(chain_id=args.chain_id, dry_run=args.dry_run), indent=2))
        return
    print(json.dumps(publish_pending(chain_id=args.chain_id, dry_run=args.dry_run), indent=2))


if __name__ == "__main__":
    main()
