"""Unit tests for polymarket_client's order helpers (TEE mode, signer HTTP seam mocked)."""
import pytest

import polymarket_client


@pytest.fixture
def tee_mode(monkeypatch):
    """Pretend a CVM order-signer is configured; capture what gets POSTed to it."""
    posts = []
    monkeypatch.setattr(polymarket_client, "ORDER_SIGNER_URL", "https://signer.test")
    monkeypatch.setattr(polymarket_client, "ORDER_SIGNER_TOKEN", "tok")
    monkeypatch.setattr(polymarket_client, "ensure_polygon_approvals", lambda: None)

    def tee_post(path, payload, timeout=300):
        posts.append((path, payload))
        return {"order_id": "ord-9", "status": "matched", "raw": {}}

    monkeypatch.setattr(polymarket_client, "_tee_post", tee_post)
    return posts


def test_tee_signing_requires_url_and_token(monkeypatch):
    monkeypatch.setattr(polymarket_client, "ORDER_SIGNER_URL", "https://signer.test")
    monkeypatch.setattr(polymarket_client, "ORDER_SIGNER_TOKEN", "")
    assert not polymarket_client.tee_signing()
    monkeypatch.setattr(polymarket_client, "ORDER_SIGNER_TOKEN", "tok")
    assert polymarket_client.tee_signing()
    assert polymarket_client.is_configured()


def test_place_order_converts_usdc_to_shares_and_uses_gtc(tee_mode):
    result = polymarket_client.place_order("tok-1", "buy", price=0.25, size_usdc=50.0)
    path, payload = tee_mode[0]
    assert path == "/polymarket/order"
    assert payload["side"] == "BUY"
    assert payload["order_type"] == "GTC"
    assert payload["size"] == pytest.approx(200.0)  # 50 USDC @ 0.25 = 200 shares
    assert result["order_id"] == "ord-9"
    assert result["shares"] == pytest.approx(200.0)


def test_sell_shares_is_share_denominated_fak(tee_mode):
    polymarket_client.sell_shares("tok-1", price=0.62, shares=123.4)
    path, payload = tee_mode[0]
    assert path == "/polymarket/order"
    assert payload["side"] == "SELL"
    assert payload["order_type"] == "FAK"  # fill-now-or-cancel: exits never rest on the book
    assert payload["size"] == pytest.approx(123.4)  # shares pass through untouched


def test_place_order_unconfigured_raises(monkeypatch):
    monkeypatch.setattr(polymarket_client, "ORDER_SIGNER_URL", "")
    monkeypatch.setattr(polymarket_client, "ORDER_SIGNER_TOKEN", "")
    monkeypatch.delenv("POLYGON_EXECUTOR_KEY", raising=False)
    with pytest.raises(polymarket_client.PolymarketNotConfigured):
        polymarket_client.place_order("tok-1", "BUY", 0.5, 10)


class FakeResponse:
    def __init__(self, body, ok=True):
        self.ok = ok
        self._body = body

    def json(self):
        return self._body

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError("http error")


def test_market_price_uses_side_price(monkeypatch):
    def get(url, params=None, timeout=None):
        assert url.endswith("/price")
        assert params == {"token_id": "tok-1", "side": "SELL"}
        return FakeResponse({"price": "0.61"})

    monkeypatch.setattr(polymarket_client.requests, "get", get)
    assert polymarket_client.market_price("tok-1", "sell") == pytest.approx(0.61)


def test_market_price_falls_back_to_midpoint(monkeypatch):
    def get(url, params=None, timeout=None):
        if url.endswith("/price"):
            return FakeResponse({}, ok=False)
        assert url.endswith("/midpoint")
        return FakeResponse({"mid": "0.44"})

    monkeypatch.setattr(polymarket_client.requests, "get", get)
    assert polymarket_client.market_price("tok-1", "SELL") == pytest.approx(0.44)
