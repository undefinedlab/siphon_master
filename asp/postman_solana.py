"""Postman for siphon-vault-zk — publish admitted/revoked roots via `publish_roots`.

The program keeps one (admitted, revoked) pair in the compliance PDA and only the key named in
the postman PDA (`set_postman`, vault-authority-only) may overwrite it. That key lives here as
SOLANA_POSTMAN_KEYPAIR (JSON byte array, like ~/.config/solana/id.json); the vault authority —
which is also the program upgrade authority — never leaves the operator's machine.

Both roots go out in one instruction, so unlike the EVM postman there is no admit/revoke split:
any drift publishes the pair.

  python postman_solana.py status
  python postman_solana.py publish
  python postman_solana.py loop
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time

from dotenv import load_dotenv

import config
from association_set import current_admitted_root, mark_admitted_published
from db import init_db, session, write_audit
from revocation_set import current_revoked_root, mark_revoked_published
from solana_indexer import pda, zk_program_id
from solana_rpc import PUBLISH_ROOTS_IX_DISC, SolanaRpc, field_to_le32, le_to_field

load_dotenv()
log = logging.getLogger("aspv2.postman_solana")

# ComplianceAccount: disc(8) | bump u8 | admitted_root [u8;32] | revoked_root [u8;32]
_ADMITTED = slice(9, 41)
_REVOKED = slice(41, 73)
# PostmanAccount: disc(8) | bump u8 | postman Pubkey
_POSTMAN = slice(9, 41)


def _keypair():
    from solders.keypair import Keypair

    raw = os.getenv("SOLANA_POSTMAN_KEYPAIR", "").strip()
    if not raw:
        raise RuntimeError("SOLANA_POSTMAN_KEYPAIR required")
    return Keypair.from_bytes(bytes(json.loads(raw)))


def read_onchain(rpc: SolanaRpc) -> dict:
    from solana_rpc import b58encode

    comp = rpc.account_data(pda(b"siphon-compliance-v1"))
    post = rpc.account_data(pda(b"siphon-postman-v1"))
    return {
        "admittedRoot": str(le_to_field(comp[_ADMITTED])) if comp else None,
        "revokedRoot": str(le_to_field(comp[_REVOKED])) if comp else None,
        "postman": b58encode(post[_POSTMAN]) if post else None,
    }


def _offchain() -> tuple[int, int]:
    init_db()
    with session() as db:
        return int(current_admitted_root(db)), int(current_revoked_root(db))


def status() -> dict:
    rpc = SolanaRpc()
    admitted, revoked = _offchain()
    onchain = read_onchain(rpc)
    out = {
        "programId": zk_program_id(),
        "admittedRoot": str(admitted),
        "revokedRoot": str(revoked),
        "onchain": onchain,
        "drift": {
            "admitted": onchain["admittedRoot"] != str(admitted),
            "revoked": onchain["revokedRoot"] != str(revoked),
        },
    }
    try:
        out["postmanKey"] = str(_keypair().pubkey())
        out["postmanMatches"] = out["postmanKey"] == onchain["postman"]
    except RuntimeError:
        out["postmanKey"] = None
    return out


def publish(*, dry_run: bool = False) -> dict:
    from solders.instruction import AccountMeta, Instruction
    from solders.message import Message
    from solders.hash import Hash
    from solders.pubkey import Pubkey
    from solders.transaction import Transaction

    rpc = SolanaRpc()
    admitted, revoked = _offchain()
    onchain = read_onchain(rpc)
    if onchain["admittedRoot"] == str(admitted) and onchain["revokedRoot"] == str(revoked):
        with session() as db:
            mark_admitted_published(db, str(admitted))
            mark_revoked_published(db, str(revoked))
            db.commit()
        return {"skipped": True, "reason": "matches_chain", "admittedRoot": str(admitted)}
    if onchain["admittedRoot"] is None:
        raise RuntimeError("compliance PDA missing — run set_compliance once as vault authority")

    kp = _keypair()
    if onchain["postman"] != str(kp.pubkey()):
        # Same guard as the EVM postman (chain_verify.assert_postman_key_matches_chain): a wrong
        # key would only burn fees on Unauthorized reverts.
        raise RuntimeError(f"postman key {kp.pubkey()} != on-chain postman {onchain['postman']}")
    if dry_run:
        return {"dryRun": True, "admittedRoot": str(admitted), "revokedRoot": str(revoked)}

    ix = Instruction(
        Pubkey.from_string(zk_program_id()),
        PUBLISH_ROOTS_IX_DISC + field_to_le32(admitted) + field_to_le32(revoked),
        [
            AccountMeta(kp.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(Pubkey.from_string(pda(b"siphon-postman-v1")), is_signer=False, is_writable=False),
            AccountMeta(Pubkey.from_string(pda(b"siphon-compliance-v1")), is_signer=False, is_writable=True),
        ],
    )
    blockhash = Hash.from_string(rpc.latest_blockhash())
    tx = Transaction([kp], Message([ix], kp.pubkey()), blockhash)
    sig = rpc.send_raw(bytes(tx))
    rpc.confirm(sig)

    with session() as db:
        mark_admitted_published(db, str(admitted))
        mark_revoked_published(db, str(revoked))
        write_audit(
            db,
            action="postman_solana_publish_roots",
            payload={"admittedRoot": str(admitted), "revokedRoot": str(revoked), "signature": sig},
            actor=str(kp.pubkey()),
        )
        db.commit()
    log.info("published roots sig=%s…", sig[:16])
    return {"signature": sig, "admittedRoot": str(admitted), "revokedRoot": str(revoked)}


def loop(interval_sec: int | None = None) -> None:
    interval = interval_sec or config.POSTMAN_INTERVAL
    log.info("solana postman loop interval=%ss", interval)
    while True:
        try:
            log.info("publish: %s", json.dumps(publish()))
        except Exception:
            log.exception("publish failed")
        time.sleep(interval)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="[postman-sol] %(levelname)s %(message)s")
    p = argparse.ArgumentParser(description="Siphon aspv2 Solana postman")
    p.add_argument("cmd", choices=["publish", "loop", "status"], nargs="?", default="publish")
    p.add_argument("--interval", type=int, default=None)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    if args.cmd == "status":
        print(json.dumps(status(), indent=2))
    elif args.cmd == "loop":
        loop(args.interval)
    else:
        print(json.dumps(publish(dry_run=args.dry_run), indent=2))


if __name__ == "__main__":
    main()
