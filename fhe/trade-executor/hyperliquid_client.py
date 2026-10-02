"""Hyperliquid for private perps: reads over the public info API, signed actions through hl_bridge.

One executor trades ONE Hyperliquid network (HYPERLIQUID_TESTNET=1 for testnet) from ONE account,
the master wallet (HYPERLIQUID_MASTER_PRIVATE_KEY). Every user's margin sits in that account, so
nothing here acts on "the account's position": orders are sized per position, and fills are read
back by each order's own client order id (cloid).

Config (env):
  HYPERLIQUID_MASTER_PRIVATE_KEY  required — holds the margin, signs payouts (see hl_bridge)
  HYPERLIQUID_PRIVATE_KEY         optional agent key for orders
  HYPERLIQUID_TESTNET             1 = testnet
  HYPERLIQUID_PYTHON              python with hyperliquid-python-sdk (default /opt/hl/bin/python)
  HYPERLIQUID_MAX_LEVERAGE        user leverage cap (default 20; also capped at half the coin's max)
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

import requests

INFO_URL_MAIN = "https://api.hyperliquid.xyz"
INFO_URL_TEST = "https://api.hyperliquid-testnet.xyz"

# LI.FI's id for HyperCore. A bridge there lands as perps USDC (6 decimals) on the recipient.
HYPERLIQUID_LIFI_ID = 1337
ARBITRUM_CHAIN_ID = 42161
# HyperEVM Testnet native vault — Option A private perps (CoreDeposit → HyperCore testnet).
HYPEREVM_TESTNET_CHAIN_ID = 998
# Where a closed position can be paid: a HyperCore usdSend (free, instant) or a withdraw3 to
# Arbitrum (Hyperliquid charges $1, ~4 min).
PAYOUT_CHAINS = (HYPERLIQUID_LIFI_ID, ARBITRUM_CHAIN_ID)


def vault_chain_id(data: dict) -> int | None:
    """Strategy's vault chain (`from_chain`), or None if missing/invalid."""
    raw = data.get("from_chain")
    if raw in (None, ""):
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def is_hyperevm_testnet_vault(data: dict) -> bool:
    return vault_chain_id(data) == HYPEREVM_TESTNET_CHAIN_ID
WITHDRAW_FEE_USD = 1.0
# Hyperliquid rejects orders under $10 notional; the margin also loses a few cents on the bridge.
MIN_NOTIONAL_USD = float(os.environ.get("HYPERLIQUID_MIN_NOTIONAL_USD", "11"))
MAX_LEVERAGE = int(os.environ.get("HYPERLIQUID_MAX_LEVERAGE", "20"))

_BRIDGE = Path(__file__).resolve().parent / "hl_bridge.py"
_META_TTL = 300.0
_meta_cache: dict = {"at": 0.0, "net": None, "by_coin": {}}


class HyperliquidNotConfigured(RuntimeError):
    """Signing key or SDK bridge missing."""


def testnet() -> bool:
    return os.environ.get("HYPERLIQUID_TESTNET", "").lower() in ("1", "true", "yes")


def is_configured() -> bool:
    return bool(os.environ.get("HYPERLIQUID_MASTER_PRIVATE_KEY", "").strip())


def account() -> str:
    """The master address: where LI.FI delivers margin and whose fills are every position's."""
    key = os.environ.get("HYPERLIQUID_MASTER_PRIVATE_KEY", "").strip()
    if not key:
        raise HyperliquidNotConfigured("HYPERLIQUID_MASTER_PRIVATE_KEY not set")
    from eth_account import Account

    return Account.from_key(key if key.startswith("0x") else "0x" + key).address


# ── reads ──────────────────────────────────────────────────────────────────────────────────────

def info(payload: dict, timeout: float = 12.0) -> Any:
    resp = requests.post(f"{INFO_URL_TEST if testnet() else INFO_URL_MAIN}/info", json=payload, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def all_mids() -> dict[str, float]:
    out: dict[str, float] = {}
    for coin, mid in (info({"type": "allMids"}) or {}).items():
        try:
            out[str(coin).upper()] = float(mid)
        except (TypeError, ValueError):
            continue
    return out


def mark_px(coin: str) -> Optional[float]:
    return all_mids().get(coin.upper())


def market(coin: str) -> Optional[dict]:
    """The coin's perp spec ({name, szDecimals, maxLeverage, ...}), or None if Hyperliquid has none."""
    now = time.time()
    if now - _meta_cache["at"] > _META_TTL or _meta_cache["net"] != testnet():
        universe = (info({"type": "meta"}) or {}).get("universe") or []
        _meta_cache.update(at=now, net=testnet(), by_coin={str(a["name"]).upper(): a for a in universe})
    return _meta_cache["by_coin"].get(coin.upper())


def leverage_cap(coin: str) -> int:
    """The most leverage a user may take on `coin`.

    Half the coin's max keeps the margin guard (hyperliquid_watcher.GUARD) above Hyperliquid's
    maintenance margin, which is half the initial margin at max leverage: at L <= max/2 a position
    is closed with >= 30% of its margin left, i.e. >= 0.6/max of notional > 0.5/max.
    """
    spec = market(coin) or {}
    return max(1, min(MAX_LEVERAGE, int(spec.get("maxLeverage") or 1) // 2))


def round_size(coin: str, size: float) -> float:
    """Floor to the coin's size step — Hyperliquid rejects any other size."""
    dec = int((market(coin) or {}).get("szDecimals") or 0)
    step = 10 ** dec
    return math.floor(size * step + 1e-9) / step


def cloid(*parts: Any) -> str:
    """Deterministic 16-byte client order id: a restarted executor finds its own order again."""
    return "0x" + hashlib.sha256(":".join(map(str, parts)).encode()).hexdigest()[:32]


def order_fills(order_cloid: str, since_ms: int) -> dict:
    """What an order did: {status, oid, sz, avg_px, fee}. status is Hyperliquid's ('filled',
    'canceled', ...) or 'unknownOid' when no order with this cloid exists.

    ponytail: reads fills since `since_ms` (Hyperliquid returns up to 2000); a busier account
    would page userFillsByTime from the last fill's time.
    """
    acct = account()
    st = info({"type": "orderStatus", "user": acct, "oid": order_cloid}) or {}
    if st.get("status") != "order":
        return {"status": "unknownOid", "oid": None, "sz": 0.0, "avg_px": 0.0, "fee": 0.0}
    oid = ((st.get("order") or {}).get("order") or {}).get("oid")
    fills = [f for f in info({"type": "userFillsByTime", "user": acct, "startTime": int(since_ms)}) or []
             if f.get("oid") == oid]
    sz = sum(float(f["sz"]) for f in fills)
    return {
        "status": (st.get("order") or {}).get("status"),
        "oid": oid,
        "sz": sz,
        "avg_px": sum(float(f["sz"]) * float(f["px"]) for f in fills) / sz if sz else 0.0,
        "fee": sum(float(f.get("fee") or 0) for f in fills),
    }


def funding_usd(coin: str, side: str, size: float, entry_px: float, start_ms: int, end_ms: int) -> float:
    """Funding the position paid (+) or received (−) over its life.

    ponytail: prices each hour at the entry price, not that hour's oracle price — exact enough
    for a position's payout; upgrade by pairing fundingHistory with candleSnapshot closes.
    """
    rows = info({"type": "fundingHistory", "coin": coin.upper(), "startTime": int(start_ms),
                 "endTime": int(end_ms)}) or []
    paid = sum(float(r.get("fundingRate") or 0) for r in rows) * size * entry_px
    return paid if side == "LONG" else -paid


# ── signed actions ─────────────────────────────────────────────────────────────────────────────

def _hl_python() -> str:
    return os.environ.get("HYPERLIQUID_PYTHON") or (
        "/opt/hl/bin/python" if os.path.isfile("/opt/hl/bin/python") else sys.executable)


def _bridge_call(req: dict, timeout: float = 60.0) -> dict:
    if not is_configured():
        raise HyperliquidNotConfigured("HYPERLIQUID_MASTER_PRIVATE_KEY not set")
    py = _hl_python()
    try:
        proc = subprocess.run([py, str(_BRIDGE)], input=json.dumps(req), capture_output=True,
                              text=True, timeout=timeout, env=os.environ.copy(), check=False)
    except FileNotFoundError as e:
        raise HyperliquidNotConfigured(f"HYPERLIQUID_PYTHON={py!r} not found") from e
    lines = (proc.stdout or "").strip().splitlines()
    try:
        data = json.loads(lines[-1]) if lines else {}
    except json.JSONDecodeError:
        data = {}
    if proc.returncode != 0 or data.get("error"):
        err = data.get("error") or (proc.stderr or "").strip()[-500:] or f"exit {proc.returncode}"
        if "not set" in err or "sdk missing" in err:
            raise HyperliquidNotConfigured(err)
        raise RuntimeError(err)
    return data


def place_order(coin: str, *, is_buy: bool, size: float, order_cloid: str) -> dict:
    """IOC market order of exactly `size`. {oid, filled_sz, avg_px} or {rejected}.

    A refusal (Hyperliquid answered with an error — no order exists) is a rejection the caller
    counts; anything else raises, and the caller finds the order again by its cloid.
    """
    if size <= 0:
        raise ValueError("size must be positive")
    spec = market(coin) or {}
    try:
        return _bridge_call({"op": "order", "coin": coin.upper(), "is_buy": is_buy, "size": size,
                             "cloid": order_cloid, "leverage": int(spec.get("maxLeverage") or 1)})
    except RuntimeError as exc:
        if str(exc).startswith("hyperliquid refused"):
            return {"rejected": str(exc)[:300]}
        raise


def send_usd(amount: float, destination: str) -> dict:
    return _bridge_call({"op": "send_usd", "amount": amount, "destination": destination})


def withdraw(amount: float, destination: str) -> dict:
    return _bridge_call({"op": "withdraw", "amount": amount, "destination": destination})


# ── strategy validation ────────────────────────────────────────────────────────────────────────

def _price(raw, name: str) -> Optional[float]:
    if raw in (None, ""):
        return None
    try:
        px = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number")
    if not math.isfinite(px) or px <= 0:
        raise ValueError(f"{name} must be positive")
    return px


def validate_order(hl_meta: dict, margin_usd: float, user: str) -> dict:
    """Normalize a HYPERLIQUID strategy's hl_meta. Raises ValueError with a user-facing message.

    `exit_to` is where the closed position is paid: by default the user's own address on HyperCore;
    the client may name another address, or Arbitrum (paid by withdraw3, $1 less).
    """
    from bridge_payout import valid_destination

    if not isinstance(hl_meta, dict):
        raise ValueError("hl_meta required")
    coin = str(hl_meta.get("coin") or "").strip().upper()
    spec = market(coin) if coin else None
    if not spec or spec.get("isDelisted"):
        raise ValueError(f"Hyperliquid has no perp market {coin or '(none)'}")
    if spec.get("onlyIsolated"):
        # An isolated position's margin is only what is allocated to it, and every user's orders
        # on one coin share that position — so it cannot be guarded per user.
        raise ValueError(f"{coin} trades isolated-only on Hyperliquid; private perps need cross margin")
    side = str(hl_meta.get("side") or "").upper()
    if side not in ("LONG", "SHORT"):
        raise ValueError("side must be LONG or SHORT")
    try:
        raw = hl_meta.get("leverage")
        leverage = 1 if raw in (None, "") else int(raw)
    except (TypeError, ValueError):
        raise ValueError("leverage must be an integer")
    cap = leverage_cap(coin)
    if not 1 <= leverage <= cap:
        raise ValueError(f"leverage on {coin} must be 1–{cap}")
    if not margin_usd > 0 or margin_usd * leverage < MIN_NOTIONAL_USD:
        raise ValueError(f"position size (margin × leverage) must be at least ${MIN_NOTIONAL_USD:g}")
    tp, sl = _price(hl_meta.get("take_profit_px"), "take_profit_px"), _price(hl_meta.get("stop_loss_px"), "stop_loss_px")
    if tp and sl and (tp <= sl if side == "LONG" else tp >= sl):
        raise ValueError("take profit must be beyond stop loss in the position's direction")

    exit_to = hl_meta.get("exit_to") or {}
    try:
        to_chain = int(exit_to.get("to_chain_id") or HYPERLIQUID_LIFI_ID)
    except (TypeError, ValueError):
        raise ValueError("exit_to.to_chain_id must be an integer")
    if to_chain not in PAYOUT_CHAINS:
        raise ValueError(f"positions pay out on Hyperliquid ({HYPERLIQUID_LIFI_ID}) or Arbitrum ({ARBITRUM_CHAIN_ID})")
    to_address = str(exit_to.get("to_address") or user or "").strip()
    if not valid_destination(to_chain, to_address):
        raise ValueError("exit_to.to_address must be an EVM address")
    return {
        "coin": coin, "side": side, "leverage": leverage,
        "take_profit_px": tp, "stop_loss_px": sl,
        "trigger_dir": "above" if str(hl_meta.get("trigger_dir") or "").lower() == "above" else "below",
        "exit_to": {"to_chain_id": to_chain, "to_address": to_address},
    }


def funding_payout(user: str, slippage_bps: Any = None) -> dict:
    """The strategy's fire-time payout: LI.FI carries the margin to THIS executor's HyperCore account.

    Built server-side so a client can never point a perp's funding anywhere else; refunds (no
    route at fire time) go back to the user on the vault chain.
    """
    return {"to_chain_id": HYPERLIQUID_LIFI_ID, "to_address": account(), "to_token": "USDC",
            "refund_address": user, "slippage_bps": 100 if slippage_bps is None else slippage_bps}


def prepare_strategy(data: dict) -> Optional[tuple[dict, int]]:
    """createStrategy's HYPERLIQUID branch. Returns (error body, status) to refuse, else None.

    A private perp is an enclave-armed WITHDRAW of a USDC note to this executor whose payout is
    built HERE (funding_payout), so the margin can only ever go to this executor's HyperCore
    account; hyperliquid_watcher opens the position when it lands. Normalizes `data` in place.
    Kill-switch: HYPERLIQUID_ENABLED=0.
    """
    from vault_generation import is_attested_strategy

    if os.environ.get("HYPERLIQUID_ENABLED", "1").lower() not in ("1", "true", "yes") or not is_configured():
        return {"error": "Hyperliquid trading is not configured on this executor",
                "code": "HYPERLIQUID_DISABLED"}, 503
    # Option A: HyperEVM Testnet (998) vault → CoreDeposit → HyperCore testnet.
    # Mainnet Base/Arb vault USDC cannot fund a testnet HL account (and vice versa).
    if testnet():
        if not is_hyperevm_testnet_vault(data):
            return {"error": "this executor trades Hyperliquid testnet — fund private perps "
                    "from the HyperEVM Testnet (998) vault",
                    "code": "HYPERLIQUID_TESTNET"}, 409
    elif is_hyperevm_testnet_vault(data):
        return {"error": "HyperEVM Testnet vault orders need HYPERLIQUID_TESTNET=1 on the executor",
                "code": "HYPERLIQUID_MAINNET"}, 409
    if not is_attested_strategy(data) or str(data.get("asset_in") or "").upper() != "USDC":
        return {"error": "a Hyperliquid order arms a USDC note through the enclave (v5 vault)"}, 400
    if data.get("legs"):
        return {"error": "a Hyperliquid order is a single leg"}, 400
    try:
        data["hl_meta"] = validate_order(data.get("hl_meta"), float(data.get("amount") or 0), data.get("user_id"))
        data["payout"] = funding_payout(data.get("user_id"), (data.get("payout") or {}).get("slippage_bps"))
    except (TypeError, ValueError) as exc:
        return {"error": f"hl_meta: {exc}"}, 400
    data["output_mode"] = "bridge"
    data["price_feed_id"] = f"hyperliquid:{data['hl_meta']['coin']}"
    return None
