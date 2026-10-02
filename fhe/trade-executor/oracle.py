"""Live prices for the trigger evaluator.

Pyth Hermes is the source of record. It now answers 401 to unauthenticated callers on both
`/api/latest_price_feeds` and `/v2/updates/price/latest`, which stopped the scheduler dead:
"No prices from oracle this cycle" every tick, so NOTHING fired — v1, v2 or v3 — while every
strategy quietly sat at PENDING inside its execution window.

The fallback is a MEDIAN of independent public spot feeds, never a first-wins pick. This price
decides whether a user's trigger fires, so a single wrong exchange print firing a limit order at
the wrong level is a worse outcome than the outage it replaces.
"""
from __future__ import annotations  # `float | None` on the Python 3.9 Docker base

import statistics

import requests

from config import PYTH_API_KEY, PYTH_HERMES_URL, PYTH_PRICE_FEED_IDS

# Independent venues per symbol. Deliberately different exchanges, not different endpoints of one:
# the point is that no single venue's outage or bad print decides a trigger.
SPOT_SOURCES = {
    "ETH": [
        ("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", lambda j: float(j["price"])),
        ("https://api.coinbase.com/v2/prices/ETH-USD/spot", lambda j: float(j["data"]["amount"])),
        ("https://api.kraken.com/0/public/Ticker?pair=ETHUSD", lambda j: float(next(iter(j["result"].values()))["c"][0])),
    ],
    "BTC": [
        ("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", lambda j: float(j["price"])),
        ("https://api.coinbase.com/v2/prices/BTC-USD/spot", lambda j: float(j["data"]["amount"])),
        ("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", lambda j: float(next(iter(j["result"].values()))["c"][0])),
    ],
    "SOL": [
        ("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", lambda j: float(j["price"])),
        ("https://api.coinbase.com/v2/prices/SOL-USD/spot", lambda j: float(j["data"]["amount"])),
    ],
    # USDC is quoted, not traded, against USD here — a venue outage must not move it off peg.
    "USDC": [],
}

_FEED_ID_TO_SYMBOL = {v.lower(): k for k, v in PYTH_PRICE_FEED_IDS.items() if v}

# A spread this wide across venues means at least one is stale or broken; refusing to price is
# safer than firing a trigger on a number no two sources agree about.
MAX_SPOT_SPREAD = 0.05


def _fetch_spot(symbol: str) -> float | None:
    """Median spot for one symbol across independent venues, or None if it cannot be trusted."""
    if symbol == "USDC":
        return 1.0
    quotes = []
    for url, extract in SPOT_SOURCES.get(symbol, []):
        try:
            r = requests.get(url, timeout=5)
            r.raise_for_status()
            value = extract(r.json())
            if value and value > 0:
                quotes.append(value)
        except Exception:
            continue
    if not quotes:
        return None
    median = statistics.median(quotes)
    if len(quotes) > 1 and (max(quotes) - min(quotes)) / median > MAX_SPOT_SPREAD:
        print(f"[Oracle] {symbol}: spot sources disagree by >{MAX_SPOT_SPREAD:.0%} {quotes} — refusing")
        return None
    return median


def _spot_fallback(price_feed_ids) -> dict:
    prices = {}
    for feed_id in price_feed_ids:
        symbol = _FEED_ID_TO_SYMBOL.get(str(feed_id).lower())
        if not symbol:
            continue
        value = _fetch_spot(symbol)
        if value is not None:
            prices[str(feed_id)] = value
    if prices:
        print(f"[Oracle] Pyth unavailable — using median spot fallback: {prices}")
    return prices


def get_live_prices(price_feed_ids):
    price_data = {}
    if not price_feed_ids:
        return {}
    try:
        ids_query = "&".join([f"ids[]={id}" for id in price_feed_ids])
        # Strip any trailing slash so a configured "…pyth.network/" doesn't become "//api" (404).
        base = PYTH_HERMES_URL.rstrip("/")
        url = f"{base}/api/latest_price_feeds?{ids_query}"
        headers = {"Authorization": f"Bearer {PYTH_API_KEY}"} if PYTH_API_KEY else {}
        response = requests.get(url, headers=headers, timeout=5)
        response.raise_for_status()
        data = response.json()

        for feed in data:
            feed_id_from_api = feed.get("id")
            if feed_id_from_api:
                price_info = feed.get("price", {})
                price_val = int(price_info.get("price", 0))
                expo = int(price_info.get("expo", 0))
                full_feed_id = "0x" + feed_id_from_api
                price_data[full_feed_id] = price_val * (10 ** expo)

        if price_data:
            print(f"[Oracle] Fetched prices from Pyth: {price_data}")
            return price_data
        print("[Oracle] Pyth returned no usable feeds — falling back to spot")
    except Exception as e:
        print(f"[Oracle] Warning: Pyth Oracle failed: {e}. Falling back to spot.")

    return _spot_fallback(price_feed_ids)
