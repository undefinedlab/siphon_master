"""BOLA: user A cannot read user B's strategy -> 404 (never 403)."""
import fakeredis
import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app


def _mock_executor(handler):
    from app.adapters.executor import ExecutorClient
    return ExecutorClient(base_url="http://exec:5005", api_token="tok", transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_get_other_wallets_strategy_is_404(monkeypatch):
    from app.deps import api_key as api_key_dep
    from app.deps import clients
    from app.deps import wallet_sig as ws
    from app.repository.models import ApiKey

    # executor returns a strategy owned by 0xBBB, but the authed wallet is 0xAAA
    def handler(request):
        return httpx.Response(200, json={"id": "s9", "user_id": "0xbbb", "status": "EXECUTED",
                                         "strategy_type": "LIMIT_SELL"})

    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)
    fake = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")
    app = create_app(start_reconciler=False)
    app.dependency_overrides[api_key_dep.verify_api_key] = lambda: fake
    app.dependency_overrides[ws.verify_wallet_sig] = lambda: "0xaaa"
    app.dependency_overrides[ws.verify_wallet_sig_or_sandbox] = lambda: "0xaaa"
    app.dependency_overrides[ws.verify_wallet_intent_or_sandbox] = lambda: "0xaaa"
    app.dependency_overrides[clients.get_executor_client] = lambda: _mock_executor(handler)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        resp = await c.get("/v1/strategies/s9", headers={"Authorization": "Bearer sk_test_x",
                                                         "X-Wallet-Address": "0xaaa"})
    assert resp.status_code == 404              # not 403 — don't confirm existence
    assert resp.json()["error_code"] == "not_found"
