import pytest
from httpx import ASGITransport, AsyncClient
import fakeredis
from fastapi import Request

from app.main import create_app
from app.deps.api_key import verify_api_key
from app.repository.session import get_db
from app.repository.models import ApiKey, AuditLog, IdempotencyKey
from app.config import get_settings


def _stash_key(key):
    def _dep(request: Request):
        request.state.api_key_id = key.id
        return key
    return _dep


def _app(monkeypatch, db, admin_token="adm-secret", api_status="active"):
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)

    # Override Settings
    from app.config import get_settings
    settings = get_settings()
    settings.admin_api_token = admin_token
    monkeypatch.setattr("app.deps.admin_auth.get_settings", lambda: settings)
    monkeypatch.setattr("app.config.get_settings", lambda: settings)


    # Seed the api key in SQLite
    fake = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status=api_status, balance_minor=1000)
    db.add(fake)
    db.commit()

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = _stash_key(fake)
    app.dependency_overrides[get_db] = lambda: db
    return app


@pytest.mark.asyncio
async def test_admin_credit_success(monkeypatch, db_session):
    app = _app(monkeypatch, db_session)

    payload = {"amount_minor": 500, "reason": "comp"}
    headers = {"X-ADMIN-TOKEN": "adm-secret", "Idempotency-Key": "adm-idem-1"}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/admin/keys/k1/credit", headers=headers, json=payload)
        assert r.status_code == 200
        body = r.json()
        assert body["api_key_id"] == "k1"
        assert body["amount_minor"] == 500
        assert body["balance_minor"] == 1500
        assert body["reason"] == "comp"
        assert "granted_at" in body

        # Check ApiKey updated in DB
        key = db_session.query(ApiKey).filter_by(id="k1").first()
        assert key.balance_minor == 1500

        # Check AuditLog inserted
        logs = db_session.query(AuditLog).filter_by(target="k1").all()
        assert len(logs) == 1
        assert logs[0].action == "credit.grant"
        assert logs[0].detail["amount_minor"] == 500

        # Check idempotency: second request is cached
        r2 = await c.post("/admin/keys/k1/credit", headers=headers, json=payload)
        assert r2.status_code == 200
        assert r2.json() == body

        # Total logs remain 1
        assert db_session.query(AuditLog).filter_by(target="k1").count() == 1


@pytest.mark.asyncio
async def test_admin_credit_unauthorized(monkeypatch, db_session):
    app = _app(monkeypatch, db_session)

    payload = {"amount_minor": 500, "reason": "comp"}
    headers = {"X-ADMIN-TOKEN": "wrong-secret"}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/admin/keys/k1/credit", headers=headers, json=payload)
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_admin_credit_disabled(monkeypatch, db_session):
    # Pass empty admin token to simulate disabled state
    app = _app(monkeypatch, db_session, admin_token="")

    payload = {"amount_minor": 500, "reason": "comp"}
    headers = {"X-ADMIN-TOKEN": "whatever"}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/admin/keys/k1/credit", headers=headers, json=payload)
    assert r.status_code == 503


@pytest.mark.asyncio
async def test_admin_credit_invalid_inputs(monkeypatch, db_session):
    app = _app(monkeypatch, db_session)
    headers = {"X-ADMIN-TOKEN": "adm-secret"}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        # Negative amount
        r1 = await c.post("/admin/keys/k1/credit", headers=headers, json={"amount_minor": -5, "reason": "test"})
        assert r1.status_code == 422

        # Empty reason
        r2 = await c.post("/admin/keys/k1/credit", headers=headers, json={"amount_minor": 500, "reason": ""})
        assert r2.status_code == 422


@pytest.mark.asyncio
async def test_admin_credit_not_found(monkeypatch, db_session):
    app = _app(monkeypatch, db_session)
    headers = {"X-ADMIN-TOKEN": "adm-secret"}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/admin/keys/nonexistent/credit", headers=headers, json={"amount_minor": 500, "reason": "test"})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_admin_credit_inactive(monkeypatch, db_session):
    # Seed inactive api key
    app = _app(monkeypatch, db_session, api_status="revoked")
    headers = {"X-ADMIN-TOKEN": "adm-secret"}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/admin/keys/k1/credit", headers=headers, json={"amount_minor": 500, "reason": "test"})
    assert r.status_code == 409
