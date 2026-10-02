"""_price_for must key the trigger price off the VOLATILE asset, never the stablecoin — else a
USDC→ETH (buy) order compares an ETH-price bound against USDC's ~$1 feed and fires instantly."""
from scheduler import _price_for
from config import PYTH_PRICE_FEED_IDS

ETH_FEED = PYTH_PRICE_FEED_IDS["ETH"]
USDC_FEED = PYTH_PRICE_FEED_IDS["USDC"]
LIVE = {ETH_FEED: 3000.0, USDC_FEED: 1.0}


def test_usdc_in_buy_uses_asset_out_price():
    # USDC→ETH: pay USDC to buy ETH → trigger must be ETH's price (3000), not USDC's ~$1.
    p = _price_for({"asset_in": "USDC", "asset_out": "ETH"}, LIVE, ETH_FEED, 3000.0, 0.0)
    assert p == 3000.0, p


def test_eth_in_sell_unchanged():
    # ETH→USDC: asset_in already volatile → ETH price, same as before (no regression).
    p = _price_for({"asset_in": "ETH", "asset_out": "USDC"}, LIVE, ETH_FEED, 3000.0, 0.0)
    assert p == 3000.0, p


def test_explicit_feed_id_still_wins():
    # An explicit price_feed_id (e.g. Polymarket) must override the asset-derived one.
    p = _price_for({"asset_in": "USDC", "asset_out": "ETH", "price_feed_id": USDC_FEED},
                   LIVE, ETH_FEED, 3000.0, 0.0)
    assert p == 1.0, p
