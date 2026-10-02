"""GET /v1/fhe-keys + PUT /v1/fhe-keys/server — fingerprint tracking, size-capped upload.

The gateway only tracks fingerprints; it never returns the raw ClientKey (which never leaves the
browser anyway). The server-key upload is size-capped BEFORE parsing.
"""
import fakeredis
import httpx
import pytest
from fastapi import Request
from httpx import ASGITransport, AsyncClient

from app.main import create_app


def _mock_executor(handler):
    from app.adapters.executor import ExecutorClient
    return ExecutorClient(base_url="http://exec:5005", api_token="tok", transport=httpx.MockTransport(handler))


def _app(monkeypatch, executor, wallet="0xaaa", max_bytes=None, *, sandbox=False,
         override_wallet=True):
    from app.deps import api_key as api_key_dep
    from app.deps import clients
    from app.deps import wallet_sig as ws
    from app.repository.models import ApiKey

    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)
    if max_bytes is not None:
        from app.config import Settings, get_settings
        base = get_settings()
        monkeypatch.setattr("app.routers.fhe_keys.get_settings",
                            lambda: base.model_copy(update={"max_server_key_bytes": max_bytes}))

    fake = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")
    app = create_app(start_reconciler=False)
    def key_dep(request: Request):
        request.state.api_key_id = fake.id
        request.state.sandbox = sandbox
        return fake

    app.dependency_overrides[api_key_dep.verify_api_key] = key_dep
    if override_wallet:
        app.dependency_overrides[ws.verify_wallet_sig] = lambda: wallet
        app.dependency_overrides[ws.verify_wallet_sig_or_sandbox] = lambda: wallet
    app.dependency_overrides[ws.verify_wallet_intent_or_sandbox] = lambda: wallet
    app.dependency_overrides[clients.get_executor_client] = lambda: executor
    return app


@pytest.mark.asyncio
async def test_get_reflects_key_presence(monkeypatch):
    def handler(request):
        assert request.url.path == "/internal/hasServerKey/0xaaa"
        assert request.headers["X-API-TOKEN"] == "tok"
        return httpx.Response(200, json={"has_key": True, "fingerprint": "fp123"})

    app = _app(monkeypatch, _mock_executor(handler))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/v1/fhe-keys", headers={"Authorization": "Bearer sk_test_x",
                                                 "X-Wallet-Address": "0xaaa"})
    assert r.status_code == 200
    assert r.json() == {"server_key_present": True, "fingerprint": "fp123"}


@pytest.mark.asyncio
async def test_put_registers_and_never_returns_key(monkeypatch):
    seen = {}

    def handler(request):
        seen["path"] = request.url.path
        return httpx.Response(200, json={"status": "ok", "fingerprint": "fpABC"})

    app = _app(monkeypatch, _mock_executor(handler))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.put("/v1/fhe-keys/server",
                        headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"},
                        json={"server_key": "abcdef", "canary": "00"})
    assert r.status_code == 200
    assert seen["path"] == "/uploadServerKey"
    assert "abcdef" not in r.text  # never echo the key bytes


@pytest.mark.asyncio
async def test_oversized_upload_rejected_before_registering(monkeypatch):
    called = {"n": 0}

    def handler(request):
        called["n"] += 1
        return httpx.Response(200, json={"status": "ok"})

    app = _app(monkeypatch, _mock_executor(handler), max_bytes=8)  # tiny cap
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.put("/v1/fhe-keys/server",
                        headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"},
                        json={"server_key": "deadbeefdeadbeef" * 4, "canary": "00"})
    assert r.status_code in (400, 413)
    assert called["n"] == 0  # executor never called — rejected before registering


@pytest.mark.asyncio
async def test_sandbox_get_needs_no_wallet_signature_or_executor(monkeypatch):
    def handler(_request):
        raise AssertionError("sandbox read must not call executor")

    app = _app(
        monkeypatch,
        _mock_executor(handler),
        sandbox=True,
        override_wallet=False,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        response = await client.get(
            "/v1/fhe-keys", headers={"Authorization": "Bearer sk_test_x"}
        )
    assert response.status_code == 200
    assert response.json() == {"server_key_present": True, "fingerprint": "sandbox"}
