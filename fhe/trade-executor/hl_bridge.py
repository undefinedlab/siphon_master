"""Hyperliquid signing bridge. Runs under HYPERLIQUID_PYTHON (the /opt/hl venv, requirements-hl.txt).

hyperliquid_client.py runs it as a subprocess: one JSON request on stdin, one JSON line on stdout.
Only SIGNED actions live here, which keeps hyperliquid-python-sdk out of the executor venv (same
pattern as clob_bridge). Reads go straight to the info API from hyperliquid_client.

Keys:
  HYPERLIQUID_MASTER_PRIVATE_KEY  the account that holds every position's margin. Hyperliquid takes
                                  transfers and withdrawals only from the account itself, so it signs
                                  those, and orders too when no agent is set.
  HYPERLIQUID_PRIVATE_KEY         optional API ("agent") wallet; signs orders and leverage only.
  HYPERLIQUID_TESTNET=1           testnet. The SDK signs for mainnet only when its URL is exactly
                                  MAINNET_API_URL, so the URL is never configurable here.

Ops (errors: {"error": ...}, exit 1):
  {"op": "ping"}                                                → {account, signer}
  {"op": "order", "coin", "is_buy", "size", "cloid", "leverage", "slippage"?}
        → {oid, filled_sz, avg_px} | {rejected: reason}  — an IOC at mid ± slippage, never reduce-only
  {"op": "send_usd", "amount", "destination"}                   → {response}   HyperCore usdSend
  {"op": "withdraw", "amount", "destination"}                   → {response}   withdraw3 to Arbitrum
"""
from __future__ import annotations

import json
import os
import sys


def _fail(msg: str) -> None:
    print(json.dumps({"error": msg}))
    sys.exit(1)


def _api_url() -> str:
    from hyperliquid.utils import constants

    testnet = os.environ.get("HYPERLIQUID_TESTNET", "").lower() in ("1", "true", "yes")
    return constants.TESTNET_API_URL if testnet else constants.MAINNET_API_URL


def _wallet(env: str):
    from eth_account import Account

    key = (os.environ.get(env) or "").strip()
    if not key:
        _fail(f"{env} not set")
    return Account.from_key(key if key.startswith("0x") else "0x" + key)


def _exchange(*, trading: bool):
    """Exchange acting for the master account. `trading` lets the agent sign, if there is one."""
    from hyperliquid.exchange import Exchange

    master = _wallet("HYPERLIQUID_MASTER_PRIVATE_KEY")
    signer = _wallet("HYPERLIQUID_PRIVATE_KEY") if trading and os.environ.get("HYPERLIQUID_PRIVATE_KEY", "").strip() else master
    return Exchange(signer, _api_url(), account_address=master.address), master.address, signer.address


def _ok(result) -> dict:
    if not isinstance(result, dict) or result.get("status") != "ok":
        raise RuntimeError(f"hyperliquid refused: {result}")
    return result


def _order(req: dict) -> dict:
    from hyperliquid.utils.types import Cloid

    ex, _account, _signer = _exchange(trading=True)
    coin = str(req["coin"]).upper()
    # The coin's leverage is ACCOUNT-wide and every user's position shares it, so it is set to the
    # cap the client computed (never a user's own number): a position's size is what carries its
    # leverage, this only decides how much of the shared margin the order may tie up.
    _ok(ex.update_leverage(int(req["leverage"]), coin, is_cross=True))
    result = _ok(ex.market_open(coin, bool(req["is_buy"]), float(req["size"]), None,
                                float(req.get("slippage") or 0.05), cloid=Cloid.from_str(req["cloid"])))
    status = (result.get("response", {}).get("data", {}).get("statuses") or [{}])[0]
    if "filled" in status:
        f = status["filled"]
        return {"oid": f.get("oid"), "filled_sz": float(f["totalSz"]), "avg_px": float(f["avgPx"])}
    # IOC: anything not filled was cancelled — an error status, or nothing at the price.
    return {"rejected": str(status.get("error") or status)}


def main() -> None:
    try:
        req = json.load(sys.stdin)
    except Exception as e:
        return _fail(f"bad request json: {e}")
    try:
        import hyperliquid.exchange  # noqa: F401
    except ImportError as e:
        return _fail(f"hyperliquid-python-sdk missing: {e} (install requirements-hl.txt)")

    op = req.get("op")
    try:
        if op == "ping":
            _ex, account, signer = _exchange(trading=True)
            out = {"account": account, "signer": signer}
        elif op == "order":
            out = _order(req)
        elif op in ("send_usd", "withdraw"):
            ex, _account, _signer = _exchange(trading=False)
            amount, dest = float(req["amount"]), str(req["destination"])
            if amount <= 0:
                return _fail("amount must be > 0")
            send = ex.usd_transfer if op == "send_usd" else ex.withdraw_from_bridge
            out = {"response": _ok(send(amount, dest))}
        else:
            return _fail(f"unknown op: {op}")
    except SystemExit:
        raise
    except Exception as e:
        return _fail(str(e))
    print(json.dumps(out))


if __name__ == "__main__":
    main()
