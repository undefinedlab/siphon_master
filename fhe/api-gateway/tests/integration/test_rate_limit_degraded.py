"""Rate limiter under a Redis outage: the in-process fallback still enforces a cap.

Supersedes the old fail-open/fail-closed split. That policy had no middle ground — read/validate
were completely unthrottled during an outage, and `proof` was blanket-denied, so a Redis blip took
withdrawals down. Both classes now fall back to a per-worker bucket. Pins the policy so a future
change is a deliberate, visible edit.
"""
import pytest
import redis as redis_lib
from unittest.mock import MagicMock

from app.deps.rate_limit import TokenBucket, _fallback


def _broken():
    m = MagicMock()
    m.pipeline.side_effect = redis_lib.ConnectionError("Connection refused")
    m.ttl.side_effect = redis_lib.ConnectionError("Connection refused")
    return m


@pytest.mark.asyncio
async def test_read_class_still_capped_when_redis_unreachable():
    _fallback.clear()
    bucket = TokenBucket(_broken(), capacity=2, refill_per_min=2)

    assert await bucket.allow("read:k1") is True
    assert await bucket.allow("read:k1") is True
    # Previously this returned True forever (fail-open) — no limit at all during an outage.
    assert await bucket.allow("read:k1") is False


@pytest.mark.asyncio
async def test_proof_class_degrades_without_total_denial():
    """proof must stay throttled, but a Redis outage must not deny every withdrawal outright."""
    _fallback.clear()
    bucket = TokenBucket(_broken(), capacity=2, refill_per_min=2)

    assert await bucket.allow("proof:k1", fail_closed=True) is True
    assert await bucket.allow("proof:k1", fail_closed=True) is True
    assert await bucket.allow("proof:k1", fail_closed=True) is False


@pytest.mark.asyncio
async def test_fallback_budget_is_per_identity():
    _fallback.clear()
    bucket = TokenBucket(_broken(), capacity=1, refill_per_min=1)

    assert await bucket.allow("proof:tenantA") is True
    assert await bucket.allow("proof:tenantA") is False
    # One noisy key must not consume another integrator's budget.
    assert await bucket.allow("proof:tenantB") is True


def test_retry_after_survives_redis_outage():
    bucket = TokenBucket(_broken(), capacity=1, refill_per_min=1)
    assert bucket.retry_after("read:k1") == 60


@pytest.mark.asyncio
async def test_allow_enforces_cap_when_redis_healthy():
    import fakeredis
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    bucket = TokenBucket(r, capacity=2, refill_per_min=2)
    assert await bucket.allow("read:k1") is True
    assert await bucket.allow("read:k1") is True
    assert await bucket.allow("read:k1") is False
