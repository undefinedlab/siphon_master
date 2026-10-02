"""Solana devnet faucet via RPC requestAirdrop."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

from solana_runtime import SOLANA_RPC_URL, SOLANA_NETWORK


def request_sol_airdrop(pubkey: str, lamports: int = 1_000_000_000) -> dict[str, Any]:
    """Airdrop SOL on the configured cluster (devnet/testnet). Mainnet will fail."""
    pubkey = (pubkey or "").strip()
    if not pubkey:
        raise ValueError("pubkey required")
    if lamports <= 0 or lamports > 5_000_000_000:
        raise ValueError("lamports must be in (0, 5 SOL]")
    net = (SOLANA_NETWORK or "devnet").lower()
    if net in ("mainnet-beta", "mainnet"):
        raise ValueError("Solana faucet is not available on mainnet; fund the wallet manually")

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "requestAirdrop",
        "params": [pubkey, int(lamports)],
    }
    req = urllib.request.Request(
        SOLANA_RPC_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.load(resp)
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:300]
        if exc.code == 429:
            raise RuntimeError(
                "Devnet faucet rate-limited (HTTP 429). Wait a minute and retry, "
                "or use Phantom’s built-in Devnet airdrop."
            ) from exc
        raise RuntimeError(f"airdrop HTTP {exc.code}: {detail!r}") from exc

    if body.get("error"):
        raise RuntimeError(f"airdrop rejected: {body['error']}")
    sig = body.get("result")
    return {
        "ok": True,
        "signature": sig,
        "pubkey": pubkey,
        "lamports": int(lamports),
        "network": net,
        "rpc": SOLANA_RPC_URL,
        "explorer": f"https://explorer.solana.com/tx/{sig}?cluster={net}",
    }


if __name__ == "__main__":
    import sys

    pk = sys.argv[1] if len(sys.argv) > 1 else os.getenv("SOLANA_FAUCET_PUBKEY", "")
    print(request_sol_airdrop(pk or "11111111111111111111111111111111", 100_000_000))
