"""Hyperliquid oracle + FHE mapping smoke tests (no live credentials)."""
import os

os.environ.setdefault("NOTE_DB_URI", "postgresql://e2e:e2e@127.0.0.1:5432/e2e")
os.environ.setdefault("SERVER_HMAC_SECRET", "e2e-hmac-secret")
os.environ.setdefault("DATABASE_URI", "sqlite:///:memory:")

from fhe_client import build_strategy_payload
from hyperliquid_oracle import coin_of, is_hyperliquid_feed


def test_feed_helpers():
    assert is_hyperliquid_feed("hyperliquid:BTC")
    assert not is_hyperliquid_feed("polymarket:1")
    assert coin_of("hyperliquid:eth") == "ETH"


def test_fhe_maps_hyperliquid_trigger_dirs():
    above = build_strategy_payload(
        {
            "id": "t1",
            "strategy_type": "HYPERLIQUID",
            "encrypted_upper_bound": "x",
            "encrypted_lower_bound": "",
            "hl_meta": {"trigger_dir": "above"},
        },
        100.0,
    )
    assert above["strategy_type"] == "LIMIT_SELL_RALLY"
    assert above["current_price_cents"] == 10000

    below = build_strategy_payload(
        {
            "id": "t2",
            "strategy_type": "HYPERLIQUID",
            "encrypted_upper_bound": "",
            "encrypted_lower_bound": "y",
            "hl_meta": {"trigger_dir": "below"},
        },
        50.0,
    )
    assert below["strategy_type"] == "LIMIT_BUY_DIP"
