"""Checks for the billing ledger and the degraded-Redis rate limiter.

These cover the two fixes that carry real arithmetic: the ledger must stay the source of truth even
if the audit log is wiped, and the limiter must still enforce a cap when Redis is unreachable.
"""
import asyncio

import pytest
import redis as redis_lib
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.deps.rate_limit import TokenBucket, _fallback
from app.repository.models import ApiKey, AuditLog, Base, CreditLedger
from app.services import credit_service


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _key(db, balance=0):
    row = ApiKey(key_hash="h", integrator_id="0xabc", plan="test", balance_minor=balance)
    db.add(row)
    db.flush()
    return row


def test_balance_survives_audit_log_wipe(db):
    """The regression that motivated the ledger: billing must not be derived from audit rows."""
    row = _key(db)
    credit_service.grant(db, row.id, 5_000, "promo", "req1")
    credit_service.grant(db, row.id, 2_500, "topup", "req2")

    assert credit_service.sum_by_kind(db, row.id, "grant") == 7_500
    assert credit_service.verify_balance(db, row.id) == (7_500, 7_500)

    # Simulate an audit-log retention policy deleting old rows.
    db.query(AuditLog).delete()
    db.flush()

    assert credit_service.sum_by_kind(db, row.id, "grant") == 7_500
    assert credit_service.verify_balance(db, row.id) == (7_500, 7_500)


def test_ledger_records_running_balance(db):
    row = _key(db)
    credit_service.grant(db, row.id, 1_000, "a", "r1")
    credit_service.post_entry(db, row, kind="debit", amount_minor=-400, reason="proof", request_id="r2")
    db.flush()

    entries = db.query(CreditLedger).order_by(CreditLedger.created_at).all()
    assert [e.balance_after for e in entries] == [1_000, 600]
    assert credit_service.verify_balance(db, row.id) == (600, 600)


def test_debit_below_zero_rejected(db):
    from app.errors import Conflict

    row = _key(db, balance=100)
    with pytest.raises(Conflict):
        credit_service.post_entry(db, row, kind="debit", amount_minor=-500, reason="x", request_id="r")


class _DeadRedis:
    """Every call raises, like a Redis outage."""

    def pipeline(self):
        raise redis_lib.RedisError("down")

    def ttl(self, *_a, **_k):
        raise redis_lib.RedisError("down")


def test_limiter_still_caps_when_redis_is_down():
    """Previously this path returned True unconditionally (fail-open) for read/validate and False
    unconditionally (fail-closed) for proof. Neither enforced an actual limit."""
    _fallback.clear()
    bucket = TokenBucket(_DeadRedis(), capacity=3, refill_per_min=3)

    results = [asyncio.run(bucket.allow("proof:key1")) for _ in range(5)]
    assert results == [True, True, True, False, False], results

    # Independent identity keeps its own budget.
    assert asyncio.run(bucket.allow("proof:key2")) is True

    # retry_after must not explode while Redis is unreachable.
    assert bucket.retry_after("proof:key1") == 60
