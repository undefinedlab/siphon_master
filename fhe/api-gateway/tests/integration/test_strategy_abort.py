import json
import fakeredis
import httpx
import pytest
from httpx import ASGITransport, AsyncClient
from datetime import datetime, timezone
from fastapi import Request

from app.main import create_app
from app.deps.api_key import verify_api_key
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox, verify_wallet_sig
from app.deps.clients import get_executor_client
from app.repository.session import get_db
from app.repository.models import ApiKey, UsageEvent


def _mock_executor(status_code=200, resp_payload=None):
    from app.adapters.executor import ExecutorClient

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if "/strategies/s1/abort" in path:
            assert request.headers.get("X-Wallet-Address") == "0xaaa"
            return httpx.Response(status_code, json=resp_payload or {
                "status": "ABORTED",
                "spent_amount": 0.0,
                "returned_amount": 10.0
            })
        return httpx.Response(404)

    return ExecutorClient(base_url="http://exec:5005", api_token="tok", transport=httpx.MockTransport(handler))


def _stash_key(key, *, sandbox=False):
    def _dep(request: Request):
        request.state.api_key_id = key.id
        request.state.sandbox = sandbox
        return key
    return _dep


def _app(monkeypatch, db, executor, wallet="0xaaa", *, sandbox=False):
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)

    fake = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")
    db.add(fake)
    db.commit()

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = _stash_key(fake, sandbox=sandbox)
    app.dependency_overrides[verify_wallet_sig] = lambda: wallet
    app.dependency_overrides[verify_wallet_intent_or_sandbox] = lambda: wallet
    app.dependency_overrides[get_executor_client] = lambda: executor
    app.dependency_overrides[get_db] = lambda: db
    return app


@pytest.mark.asyncio
async def test_abort_strategy_success(monkeypatch, db_session):
    exec_mock = _mock_executor(status_code=200)
    app = _app(monkeypatch, db_session, exec_mock)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/strategies/s1/abort",
                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ABORTED"
    assert body["spent_amount"] == 0.0
    assert body["returned_amount"] == 10.0

    # Not metered: no usage event is written
    events = db_session.query(UsageEvent).all()
    assert len(events) == 0


@pytest.mark.asyncio
async def test_abort_strategy_already_executed_conflict(monkeypatch, db_session):
    # If the executor returns 409, the gateway should propagate it as 409 Conflict.
    exec_mock = _mock_executor(status_code=409, resp_payload={"error": "strategy already executed"})
    app = _app(monkeypatch, db_session, exec_mock)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/strategies/s1/abort",
                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"})
    assert r.status_code == 409
    assert r.json()["error_code"] == "conflict"


@pytest.mark.asyncio
async def test_abort_other_wallets_strategy_is_404_not_403(monkeypatch, db_session):
    # BOLA (§3.5): the executor returns 403 for a non-owner (which confirms existence); the gateway
    # must translate that to 404 so abort matches every other owner-scoped route.
    exec_mock = _mock_executor(status_code=403,
                               resp_payload={"error": "wallet signature does not match strategy owner"})
    app = _app(monkeypatch, db_session, exec_mock)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/strategies/s1/abort",
                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"})
    assert r.status_code == 404
    assert r.json()["error_code"] == "not_found"


@pytest.mark.asyncio
async def test_sandbox_abort_never_calls_executor(monkeypatch, db_session):
    class Executor:
        def abort_strategy(self, *_args, **_kwargs):
            raise AssertionError("sandbox must not call the executor")

    app = _app(monkeypatch, db_session, Executor(), sandbox=True)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        response = await client.post(
            "/v1/strategies/sandbox_1/abort",
            headers={"Authorization": "Bearer sk_test_x"},
        )
    assert response.status_code == 200
    assert response.json() == {"strategy_id": "sandbox_1", "status": "aborted"}
