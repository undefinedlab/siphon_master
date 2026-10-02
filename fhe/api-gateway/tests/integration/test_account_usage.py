import pytest
from httpx import ASGITransport, AsyncClient
import fakeredis
from fastapi import Request

from app.main import create_app
from app.deps.api_key import verify_api_key
from app.repository.session import get_db
from app.repository.models import ApiKey, UsageEvent, CreditLedger


def _stash_key(key):
    def _dep(request: Request):
        request.state.api_key_id = key.id
        return key
    return _dep


def _app(monkeypatch, db, api_key_id="k1"):
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)

    # Seed the api key in SQLite
    fake = ApiKey(id=api_key_id, key_hash="h", integrator_id="i", plan="test", status="active", balance_minor=1000)
    db.add(fake)
    db.commit()

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = _stash_key(fake)
    app.dependency_overrides[get_db] = lambda: db
    return app


@pytest.mark.asyncio
async def test_get_account_usage_empty(monkeypatch, db_session):
    app = _app(monkeypatch, db_session)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/v1/account/usage", headers={"Authorization": "Bearer sk_test_x"})
        assert r.status_code == 200
        body = r.json()
        assert body["period"] == "all-time"
        assert body["counts_by_event_type"] == {}
        assert body["total_amount_minor"] == 0
        assert body["granted_credit_minor"] == 0
        assert body["balance_minor"] == 1000


@pytest.mark.asyncio
async def test_get_account_usage_with_data(monkeypatch, db_session):
    app = _app(monkeypatch, db_session)

    # 1. Seed some usage events
    event1 = UsageEvent(
        id="e1", api_key_id="k1", event_type="strategy_created", amount_minor=250000, request_id="r1"
    )
    event2 = UsageEvent(
        id="e2", api_key_id="k1", event_type="strategy_created", amount_minor=250000, request_id="r2"
    )
    event3 = UsageEvent(
        id="e3", api_key_id="k1", event_type="execution", amount_minor=200000, request_id="r3"
    )
    # Event for another key to check isolation
    event4 = UsageEvent(
        id="e4", api_key_id="k2", event_type="execution", amount_minor=200000, request_id="r4"
    )
    db_session.add_all([event1, event2, event3, event4])

    # 2. Seed credit grants in the ledger (the billing source of truth — NOT the audit log, which
    #    is a security trail and may be pruned by retention policy).
    grant1 = CreditLedger(
        api_key_id="k1", kind="grant", amount_minor=1500, balance_after=1500,
        reason="comp", request_id="req1",
    )
    grant2 = CreditLedger(
        api_key_id="k1", kind="grant", amount_minor=500, balance_after=2000,
        reason="comp2", request_id="req2",
    )
    grant3 = CreditLedger(
        api_key_id="k2", kind="grant", amount_minor=5000, balance_after=5000,
        reason="other key", request_id="req3",
    )
    # A debit must not reduce the "granted" total — different kind.
    debit1 = CreditLedger(
        api_key_id="k1", kind="debit", amount_minor=-300, balance_after=1700,
        reason="proof", request_id="req4",
    )
    db_session.add_all([grant1, grant2, grant3, debit1])
    db_session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/v1/account/usage", headers={"Authorization": "Bearer sk_test_x"})
        assert r.status_code == 200
        body = r.json()
        assert body["counts_by_event_type"] == {"strategy_created": 2, "execution": 1}
        assert body["total_amount_minor"] == 700000
        assert body["granted_credit_minor"] == 2000
        assert body["balance_minor"] == 1000


@pytest.mark.asyncio
async def test_get_fee_quote(monkeypatch, db_session):
    app = _app(monkeypatch, db_session)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/v1/fees/quote", headers={"Authorization": "Bearer sk_test_x"})
        assert r.status_code == 200
        body = r.json()
        assert body["arming_fee_minor"] == 250000
        assert body["execution_fee_minor"] == 200000
        assert body["gas_reimbursement_minor"] == 100000
