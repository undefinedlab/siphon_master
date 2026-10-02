"""Polymarket CLOB odds feed for the FHE trigger engine.

Returns live outcome odds keyed ``polymarket:<token_id>`` in the SAME ``{feed_id: value}`` shape as
``oracle.get_live_prices``, so the scheduler can merge them into ``live_prices`` and ``_price_for`` /
``evaluate_tree_encrypted`` treat a Polymarket market exactly like a Pyth price feed — no engine or
_price_for change.

Units: odds are reported as PERCENT (0..100) — a 47%-probability outcome → ``47.0``. This matches how
the browser encrypts an odds threshold (``encryptPrice(70)`` for "70%"): both the encrypted threshold
and this live value pass through the engine's ``current_price * 100`` scaling, so the homomorphic
comparison happens in basis points (0.01% resolution).
"""
import os
import requests

CLOB_BASE = os.environ.get("POLYMARKET_CLOB_URL", "https://clob.polymarket.com").rstrip("/")
POLY_FEED_PREFIX = "polymarket:"
_TIMEOUT = float(os.environ.get("POLYMARKET_CLOB_TIMEOUT", "8"))


def is_polymarket_feed(feed_id) -> bool:
    return bool(feed_id) and str(feed_id).startswith(POLY_FEED_PREFIX)


def token_id_of(feed_id) -> str:
    return str(feed_id)[len(POLY_FEED_PREFIX):]


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def get_polymarket_odds(feed_ids):
    """feed_ids: iterable of ``polymarket:<token_id>`` strings (non-Polymarket ids are ignored).

    Returns ``{polymarket:<token_id>: odds_percent}`` where odds_percent ∈ [0, 100]. Best-effort:
    on any failure the affected feeds are simply absent (the scheduler leaves those strategies
    un-armed this cycle rather than firing on a bad reading).
    """
    token_ids = [token_id_of(f) for f in feed_ids if is_polymarket_feed(f)]
    if not token_ids:
        return {}

    out = {}
    try:
        # Midpoint = (best bid + best ask) / 2 per token, from one batched /prices request
        # (BUY = best ask, SELL = best bid). Midpoint is fairer for a trigger than a single side.
        payload = []
        for t in token_ids:
            payload.append({"token_id": t, "side": "BUY"})
            payload.append({"token_id": t, "side": "SELL"})
        resp = requests.post(f"{CLOB_BASE}/prices", json=payload, timeout=_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()  # {token_id: {"BUY": "0.47", "SELL": "0.49"}}
        for tid in token_ids:
            sides = data.get(tid) or {}
            buy, sell = _f(sides.get("BUY")), _f(sides.get("SELL"))
            mid = (buy + sell) / 2.0 if (buy and sell) else (buy or sell)
            if mid > 0:
                out[f"{POLY_FEED_PREFIX}{tid}"] = mid * 100.0  # probability → percent
        if out:
            print(f"[PolymarketOracle] odds: " +
                  ", ".join(f"{k[-6:]}={v:.1f}%" for k, v in out.items()))
    except Exception as e:
        print(f"[PolymarketOracle] odds fetch failed: {e}")
    return out


def get_single_odds(token_id) -> float:
    """Live midpoint odds (percent) for one token_id, or 0.0 on failure. Used at execution time."""
    return get_polymarket_odds([f"{POLY_FEED_PREFIX}{token_id}"]).get(f"{POLY_FEED_PREFIX}{token_id}", 0.0)
