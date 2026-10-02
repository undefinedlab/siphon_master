"""GET /v1/strategies + /{id} — owner-scoped; executor statuses mapped to lifecycle names."""
import fakeredis
import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app
from app.services import strategy_service


def _mock_executor(handler):
    from app.adapters.executor import ExecutorClient
    return ExecutorClient(base_url="http://exec:5005", api_token="tok", transport=httpx.MockTransport(handler))


def _app(monkeypatch, executor, wallet="0xaaa"):
    from app.deps import api_key as api_key_dep
    from app.deps import clients
    from app.deps import wallet_sig as ws
    from app.repository.models import ApiKey

    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)
    fake = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")
    app = create_app(start_reconciler=False)
    app.dependency_overrides[api_key_dep.verify_api_key] = lambda: fake
    app.dependency_overrides[ws.verify_wallet_sig] = lambda: wallet
    app.dependency_overrides[ws.verify_wallet_sig_or_sandbox] = lambda: wallet
    app.dependency_overrides[clients.get_executor_client] = lambda: executor
    return app


def test_status_mapping():
    assert strategy_service.lifecycle_status("PENDING") == "armed"
    assert strategy_service.lifecycle_status("EXECUTED") == "executed"
    assert strategy_service.lifecycle_status("PARTIALLY_EXECUTED") == "partially_executed"
    assert strategy_service.lifecycle_status("ABORTED") == "aborted"
    assert strategy_service.lifecycle_status("EXPIRED") == "expired"
    assert strategy_service.lifecycle_status("FAILED") == "failed"


@pytest.mark.asyncio
async def test_list_returns_only_authed_wallet(monkeypatch):
    def handler(request):
        assert request.url.path == "/strategies/0xaaa"  # scoped by authed wallet
        return httpx.Response(200, json={"status": "success", "strategies": [
            {"id": "s1", "strategy_type": "LIMIT_SELL", "status": "PENDING", "asset_in": "ETH", "asset_out": "USDC"},
        ]})

    app = _app(monkeypatch, _mock_executor(handler))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/v1/strategies", headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"})
    assert r.status_code == 200
    items = r.json()["strategies"]
    assert len(items) == 1 and items[0]["id"] == "s1"
    assert items[0]["status"] == "armed"  # mapped from PENDING


@pytest.mark.asyncio
async def test_get_owns_strategy_returns_view(monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"id": "s1", "user_id": "0xaaa", "status": "EXECUTED",
                                         "strategy_type": "LIMIT_SELL", "tx_hash": "0xtx"})

    app = _app(monkeypatch, _mock_executor(handler))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/v1/strategies/s1", headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"})
    assert r.status_code == 200
    assert r.json()["status"] == "executed"
