"""Per-key rate limiting — Redis fixed-window counter (consistent with the executor's proven
INCR+TTL+EXPIRE primitive in PR #7's auth.py, adapted to a FastAPI-native, per-API-key limiter).
"""
import fakeredis
import pytest

from app.deps.rate_limit import TokenBucket


@pytest.mark.asyncio
async def test_proof_bucket_blocks_after_limit():
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    b = TokenBucket(r, capacity=10, refill_per_min=10)
    for _ in range(10):
        assert (await b.allow("key:abc")) is True
    assert (await b.allow("key:abc")) is False  # 11th in the same minute -> blocked


@pytest.mark.asyncio
async def test_different_key_is_unaffected():
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    b = TokenBucket(r, capacity=10, refill_per_min=10)
    for _ in range(10):
        await b.allow("key:abc")
    assert (await b.allow("key:abc")) is False        # exhausted
    assert (await b.allow("key:other")) is True       # independent bucket unaffected


@pytest.mark.asyncio
async def test_retry_after_is_positive_when_blocked():
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    b = TokenBucket(r, capacity=1, refill_per_min=1)
    assert (await b.allow("key:x")) is True
    assert (await b.allow("key:x")) is False
    assert b.retry_after("key:x") >= 1                # window TTL, seconds
