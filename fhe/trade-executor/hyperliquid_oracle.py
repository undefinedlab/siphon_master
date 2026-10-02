"""Hyperliquid mark-price feed for the FHE trigger engine.

Returns live mids keyed ``hyperliquid:<COIN>`` in the same ``{feed_id: value}`` shape as
``oracle.get_live_prices``, so the scheduler can merge them into ``live_prices``.

Units: USD mark (e.g. BTC ≈ 95000.0) — same scale the browser uses with ``encryptPrice``.
"""
from __future__ import annotations

import hyperliquid_client

HL_FEED_PREFIX = "hyperliquid:"


def is_hyperliquid_feed(feed_id) -> bool:
    return bool(feed_id) and str(feed_id).startswith(HL_FEED_PREFIX)


def coin_of(feed_id) -> str:
    return str(feed_id)[len(HL_FEED_PREFIX):].upper()


def get_hyperliquid_marks(feed_ids) -> dict:
    """feed_ids: iterable of ``hyperliquid:<COIN>``. Missing/failed feeds are omitted."""
    coins = [coin_of(f) for f in feed_ids if is_hyperliquid_feed(f)]
    if not coins:
        return {}
    try:
        mids = hyperliquid_client.all_mids()
    except Exception as e:
        print(f"[HL Oracle] allMids failed: {e}")
        return {}
    out = {}
    for c in coins:
        px = mids.get(c)
        if px is not None and px > 0:
            out[f"{HL_FEED_PREFIX}{c}"] = float(px)
    return out
