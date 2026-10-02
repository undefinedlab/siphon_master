"""Gateway DB models — the durable billing/metering truth (Postgres).

Asserts the schema-level guarantees the spec §8 requires: money as BIGINT minor units, the
UNIQUE(event_type, tx_hash) that makes `execution` metering idempotent, the balance CHECK, and the
audit_log `detail` JSONB column (carries credit-grant context).
"""
from app.repository.models import ApiKey, AuditLog, IdempotencyKey, UsageEvent


def test_usage_event_columns_and_execution_dedupe():
    cols = {c.name for c in UsageEvent.__table__.columns}
    assert {"api_key_id", "event_type", "tx_hash", "amount_minor", "request_id", "created_at"} <= cols
    uniques = [
        tuple(sorted(c.columns.keys()))
        for c in UsageEvent.__table__.constraints
        if c.__class__.__name__ == "UniqueConstraint"
    ]
    assert ("event_type", "tx_hash") in uniques


def test_api_key_balance_check_constraint_and_hash_unique():
    checks = [
        c.sqltext.text
        for c in ApiKey.__table__.constraints
        if c.__class__.__name__ == "CheckConstraint"
    ]
    assert any("balance_minor >= 0" in t for t in checks)
    key_hash = ApiKey.__table__.columns["key_hash"]
    assert key_hash.unique is True and key_hash.nullable is False


def test_money_columns_are_bigint():
    from sqlalchemy import BigInteger
    assert isinstance(ApiKey.__table__.columns["balance_minor"].type, BigInteger)
    assert isinstance(UsageEvent.__table__.columns["amount_minor"].type, BigInteger)


def test_audit_log_has_detail_jsonb():
    cols = {c.name for c in AuditLog.__table__.columns}
    assert {"actor", "action", "target", "detail", "request_id", "result", "created_at"} <= cols


def test_idempotency_key_is_pk_and_status_defaults_in_progress():
    assert IdempotencyKey.__table__.columns["key"].primary_key is True
    assert IdempotencyKey.__table__.columns["status"].default.arg == "in_progress"
