#!/usr/bin/env python3
"""Fire a dummy Meteora settle against Devnet (invalid proof). Proves relayer + scripts + RPC."""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import solana_devnet_strategy as s  # noqa: E402

EXECUTOR = os.getenv("SOLANA_DEVNET_EXECUTOR_URL", "https://siphon-fhe-sol-production.up.railway.app").rstrip("/")


def main() -> int:
    with urllib.request.urlopen(f"{EXECUTOR}/solana/settlement", timeout=30) as resp:
        meta = json.loads(resp.read().decode())
    settle = meta.get("pubkey") or s.settlement_pubkey()
    pool = meta.get("meteoraPool") or os.getenv("METEORA_POOL", "")
    if not pool:
        print("no meteora pool")
        return 1

    zkp = {
        "venue": "meteora-dlmm",
        "proof_hex": "ab" * 256,
        "binder_hex": "cd" * 32,
        "publics": ["0"] * 25,
        "nullifiers_hex": ["11" * 32],
        "mint": "So11111111111111111111111111111111111111112",
        "settlement": settle,
        "meteora_pool": pool,
        "circuit_index": 0,
        "return_precommitment": "123456789",
        "return_user_salt": "456789",
    }
    err = s.validate_meteora_zk_package(zkp, settlement=settle, vault_output=True)
    if err:
        print(f"package invalid: {err}")
        return 1

    script = s._meteora_script()
    if not script.is_file():
        print(f"missing script: {script}")
        return 1

    print(f"settle via {script.name} -> pool {pool[:8]}...")
    out = s.settle({"output_mode": "vault", "max_slippage_bps": 50}, zkp)
    print(json.dumps({k: out.get(k) for k in ("ok", "status", "code", "error", "message")}, indent=2))

    err = str(out.get("error") or out.get("message") or "")
    if "missing" in err.lower() and "execute-zk-meteora" in err:
        return 1
    if "MODULE_NOT_FOUND" in err:
        print("node deps missing next to settlement script")
        return 1
    # Invalid proof must fail on-chain / verify — not because the script is absent.
    if out.get("status") in ("FAILED", "NEEDS_REPROOF", "NO_ROUTE"):
        print("on-chain probe ok (expected failure with live script)")
        return 0
    if out.get("status") == "EXECUTED":
        print("unexpected EXECUTED on dummy proof")
        return 1
    print(f"unexpected result: {out}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
