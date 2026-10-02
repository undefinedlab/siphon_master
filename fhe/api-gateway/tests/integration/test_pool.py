"""GET /v1/pool/{chain}/{asset} — public pool state, API-key + read-rate-limit gated, no secrets."""
import fakeredis
import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app


def _app_with(overrides):
    app = create_app(start_reconciler=False)
    app.dependency_overrides.update(overrides)
    return app


async def _get(app, path, headers=None):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        return await c.get(path, headers=headers or {})


def _mock_executor(leaves_payload):
    from app.adapters.executor import ExecutorClient

    def handler(request):
        return httpx.Response(200, json=leaves_payload)

    return ExecutorClient(base_url="http://exec:5005", api_token="tok",
                          transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_no_api_key_is_401():
    app = create_app(start_reconciler=False)
    r = await _get(app, "/v1/pool/8453/ETH")
    assert r.status_code == 401
    assert r.json()["error_code"] == "unauthorized"


@pytest.mark.asyncio
async def test_valid_key_returns_poolstate_fields_only(monkeypatch):
    from app.deps import api_key as api_key_dep
    from app.deps import clients
    from app.deps import rate_limit as rl
    from app.repository.models import ApiKey

    # stub auth + rate limit + executor client
    fake = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")
    app = _app_with({
        api_key_dep.verify_api_key: lambda: fake,
        rl.rate_limit("read"): lambda: None,
        clients.get_executor_client: lambda: _mock_executor(
            {"root": "0xabc", "size": 42, "leaves_count": 42}
        ),
    })
    r = await _get(app, "/v1/pool/8453/ETH", headers={"Authorization": "Bearer sk_test_x"})
    assert r.status_code == 200
    body = r.json()
    assert body == {"chain_id": 8453, "asset": "ETH", "root": "0xabc", "size": 42, "leaves_count": 42}


@pytest.mark.asyncio
async def test_rate_limit_blocks_after_cap(monkeypatch):
    from app.deps import api_key as api_key_dep
    from app.deps import clients
    from app.repository.models import ApiKey

    # real rate_limit dependency, backed by fakeredis; tiny cap so we hit it fast
    from app.config import Settings

    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_settings",
                        lambda: Settings(rate_read_per_min=3))

    fake = ApiKey(id="kRL", key_hash="h", integrator_id="i", plan="test", status="active")
    app = _app_with({
        api_key_dep.verify_api_key: _stash_key(fake),
        clients.get_executor_client: lambda: _mock_executor({"root": "0x0", "size": 0, "leaves_count": 0}),
    })

    hdr = {"Authorization": "Bearer sk_test_x"}
    codes = [(await _get(app, "/v1/pool/8453/ETH", headers=hdr)).status_code for _ in range(4)]
    assert codes[:3] == [200, 200, 200]
    assert codes[3] == 429
    # last response carries Retry-After
    last = await _get(app, "/v1/pool/8453/ETH", headers=hdr)
    assert last.status_code == 429 and "retry-after" in {k.lower() for k in last.headers}


def _stash_key(key):
    """A verify_api_key override that also stashes api_key_id on request.state, so the real rate
    limiter keys by it (mirrors what the real verify_api_key does)."""
    from fastapi import Request

    def _dep(request: Request):
        request.state.api_key_id = key.id
        return key

    return _dep
