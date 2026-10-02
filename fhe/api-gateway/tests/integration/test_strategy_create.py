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
from app.repository.models import ApiKey, UsageEvent, IdempotencyKey
from app.deps.rate_limit import rate_limit


@pytest.fixture(autouse=True)
def _active_generation(monkeypatch):
    """Give these tests an active generation.

    The root conftest strips GENERATION_MANIFEST_PATH so policy tests exercise env-based config,
    and nothing then supplies the env — so every strategy call 503'd `vault_generation_unavailable`
    and these assertions never reached the behaviour they exist to check. Production mounts the
    pinned manifest (docker-compose.prod.yml), so this was a harness gap, not a live one. Tests that
    need the generation ABSENT or exit-only set their own values and still win: monkeypatch applies
    in fixture order, then the test body.
    """
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-hard-asp-v1")


def _mock_executor(has_key=True, create_resp=None):
    from app.adapters.executor import ExecutorClient

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if "/hasServerKey/" in path:
            return httpx.Response(200, json={"hasKey": has_key})
        elif path == "/createStrategy":
            payload = json.loads(request.content)
            assert "billing_ref" in payload
            assert payload["user_id"] == "0xaaa"
            resp = create_resp or {"status": "success", "strategy_id": "s1", "leg_count": 1}
            return httpx.Response(201, json=resp)
        return httpx.Response(404)

    return ExecutorClient(base_url="http://exec:5005", api_token="tok", transport=httpx.MockTransport(handler))


def _stash_key(key):
    def _dep(request: Request):
        request.state.api_key_id = key.id
        return key
    return _dep


def _app(monkeypatch, db, executor, wallet="0xaaa"):
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)

    # Seed the api key in SQLite
    fake = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")
    db.add(fake)
    db.commit()

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = _stash_key(fake)
    app.dependency_overrides[verify_wallet_sig] = lambda: wallet
    app.dependency_overrides[verify_wallet_intent_or_sandbox] = lambda: wallet
    app.dependency_overrides[get_executor_client] = lambda: executor
    app.dependency_overrides[get_db] = lambda: db
    return app


@pytest.mark.asyncio
async def test_create_strategy_fhe_keys_missing(monkeypatch, db_session):
    exec_mock = _mock_executor(has_key=False)
    app = _app(monkeypatch, db_session, exec_mock)

    payload = {
        "strategy_type": "LIMIT_SELL",
        "chain_id": 8453,
        "vault_generation_id": "base-hard-asp-v1",
        "amount": 1.0,
        "encrypted_upper_bound": "0xdead"
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/strategies",
                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa", "Idempotency-Key": "missing-fhe"},
                         json=payload)
    assert r.status_code == 409
    assert r.json()["error_code"] == "fhe_keys_missing"


@pytest.mark.asyncio
async def test_create_strategy_success(monkeypatch, db_session):
    exec_mock = _mock_executor(has_key=True)
    app = _app(monkeypatch, db_session, exec_mock)

    payload = {
        "strategy_type": "LIMIT_SELL",
        "chain_id": 8453,
        "vault_generation_id": "base-hard-asp-v1",
        "amount": 1.0,
        "encrypted_upper_bound": "0xdead"
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/strategies",
                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa", "Idempotency-Key": "strategy-success"},
                         json=payload)
    assert r.status_code == 200, f"Unexpected response: {r.json()}"
    body = r.json()
    assert body["id"] == "s1"
    assert body["status"] == "armed"
    assert body["strategy_type"] == "LIMIT_SELL"
    assert body["amount"] == 1.0

    # Ensure one usage event was created
    events = db_session.query(UsageEvent).all()
    assert len(events) == 1
    assert events[0].event_type == "strategy_created"
    assert events[0].strategy_id == "s1"
    assert events[0].api_key_id == "k1"


@pytest.mark.asyncio
async def test_create_strategy_idempotency(monkeypatch, db_session):
    exec_mock = _mock_executor(has_key=True)
    app = _app(monkeypatch, db_session, exec_mock)

    payload = {
        "strategy_type": "LIMIT_SELL",
        "chain_id": 8453,
        "vault_generation_id": "base-hard-asp-v1",
        "amount": 1.0,
        "encrypted_upper_bound": "0xdead"
    }

    headers = {
        "Authorization": "Bearer sk_test_x",
        "X-Wallet-Address": "0xaaa",
        "Idempotency-Key": "ikey1"
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r1 = await c.post("/v1/strategies", headers=headers, json=payload)
        assert r1.status_code == 200
        
        # Second request with same key/body should be cached
        r2 = await c.post("/v1/strategies", headers=headers, json=payload)
        assert r2.status_code == 200
        assert r1.json() == r2.json()

    # Ensure exactly one usage event was created
    events = db_session.query(UsageEvent).all()
    assert len(events) == 1


@pytest.mark.asyncio
async def test_create_strategy_rate_limiting(monkeypatch, db_session):
    from app.config import Settings
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_settings", lambda: Settings(rate_proof_per_min=2))

    exec_mock = _mock_executor(has_key=True)
    
    # Do not override the proof rate limiter (use the real one)
    app = create_app(start_reconciler=False)
    fake = ApiKey(id="kRL", key_hash="h", integrator_id="i", plan="test", status="active")
    db_session.add(fake)
    db_session.commit()

    app.dependency_overrides[verify_api_key] = _stash_key(fake)
    app.dependency_overrides[verify_wallet_sig] = lambda: "0xaaa"
    app.dependency_overrides[verify_wallet_intent_or_sandbox] = lambda: "0xaaa"
    app.dependency_overrides[get_executor_client] = lambda: exec_mock
    app.dependency_overrides[get_db] = lambda: db_session

    payload = {
        "strategy_type": "LIMIT_SELL",
        "chain_id": 8453,
        "vault_generation_id": "base-hard-asp-v1",
        "amount": 1.0,
        "encrypted_upper_bound": "0xdead"
    }

    headers = {
        "Authorization": "Bearer sk_test_x",
        "X-Wallet-Address": "0xaaa",
        "Idempotency-Key": "strategy-rate-limit",
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        # First 2 requests should pass
        r1 = await c.post("/v1/strategies", headers=headers, json=payload)
        assert r1.status_code == 200, f"Unexpected r1 response: {r1.json()}"
        r2 = await c.post("/v1/strategies", headers=headers, json=payload)
        assert r2.status_code == 200
        
        # 3rd request should fail with 429
        r3 = await c.post("/v1/strategies", headers=headers, json=payload)
        assert r3.status_code == 429


@pytest.mark.asyncio
async def test_create_strategy_rejects_exit_only_generation(monkeypatch, db_session):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-hard-asp-v1")
    monkeypatch.setenv("EXIT_ONLY_VAULT_GENERATIONS", "base-legacy-2026-07")
    app = _app(monkeypatch, db_session, _mock_executor(has_key=True))
    payload = {
        "strategy_type": "LIMIT_SELL",
        "chain_id": 8453,
        "vault_generation_id": "base-legacy-2026-07",
        "amount": 1.0,
        "encrypted_upper_bound": "0xdead",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        response = await client.post(
            "/v1/strategies",
            headers={
                "Authorization": "Bearer sk_test_x",
                "X-Wallet-Address": "0xaaa",
                # Required by the route before any policy check, so without it these asserted a
                # generation verdict against a request that only ever produced a 400.
                "Idempotency-Key": "exit-only-generation",
            },
            json=payload,
        )
    assert response.status_code == 409
    assert response.json()["error_code"] == "vault_exit_only"


@pytest.mark.asyncio
async def test_create_strategy_rejects_unclassified_old_row(monkeypatch, db_session):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-hard-asp-v1")
    app = _app(monkeypatch, db_session, _mock_executor(has_key=True))
    payload = {
        "strategy_type": "LIMIT_SELL",
        "chain_id": 8453,
        "amount": 1.0,
        "encrypted_upper_bound": "0xdead",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        response = await client.post(
            "/v1/strategies",
            headers={
                "Authorization": "Bearer sk_test_x",
                "X-Wallet-Address": "0xaaa",
                "Idempotency-Key": "unclassified-old-row",
            },
            json=payload,
        )
    assert response.status_code == 409
    assert response.json()["error_code"] == "vault_generation_required"


@pytest.mark.asyncio
async def test_sandbox_strategy_never_calls_executor(monkeypatch, db_session):
    from app.services.sandbox import fake_wallet

    redis = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: redis)
    key = ApiKey(id="sandbox-key", key_hash="h-sandbox", integrator_id="i", plan="test", status="active")
    db_session.add(key)
    db_session.commit()

    def stash(request: Request):
        request.state.api_key_id = key.id
        request.state.sandbox = True
        return key

    class Executor:
        def __getattr__(self, name):
            raise AssertionError(f"sandbox called executor method {name}")

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = stash
    app.dependency_overrides[verify_wallet_intent_or_sandbox] = lambda: fake_wallet(key.id)
    app.dependency_overrides[get_executor_client] = lambda: Executor()
    app.dependency_overrides[get_db] = lambda: db_session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        response = await client.post(
            "/v1/strategies",
            headers={"Idempotency-Key": "sandbox-strategy"},
            json={"strategy_type": "LIMIT_SELL", "chain_id": 8453, "amount": 1},
        )

    assert response.status_code == 200, response.text
    assert response.json()["id"].startswith("sandbox_")
