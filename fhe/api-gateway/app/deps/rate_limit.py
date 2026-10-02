"""Per-API-key rate limiting — Redis fixed-window counter.

Algorithm mirrors the executor's proven primitive (PR #7 auth.py `_allow_redis`): pipeline
INCR + TTL, set the window EXPIRE on the first hit, block once the count exceeds the cap. Adapted to
a FastAPI-native, per-API-key limiter. The pipeline is one round-trip (correct across replicas — the
INCR is atomic; a lost EXPIRE on the very first tick self-heals on the next INCR's TTL check, exactly
as in the executor).

Classes (spec §4, env-configurable): read 100/min · proof 10/min · validate 30/min. The proof class
is the key lever — each proof burns rapidsnark compute — so it is the tightest.
"""
import logging
import threading
import time
from typing import Literal

import redis as redis_lib

from app.config import get_settings
from app.errors import RateLimited
from app.repository.redis_client import get_redis

logger = logging.getLogger("siphon.gateway.ratelimit")

_WINDOW_SECONDS = 60

# ---------------------------------------------------------------------------
# In-process fallback limiter — used only while Redis is unreachable.
#
# ponytail: per-worker fixed window, so the effective cluster-wide cap during an outage is
# capacity x worker_count. That is a deliberate trade: an approximate limit that always holds beats
# either fail-open (no limit at all on `proof`, which burns rapidsnark and on-chain spend) or
# fail-closed (a Redis blip takes withdrawals down entirely). Move to a shared secondary store only
# if outage-window over-admission is ever measured to matter.
# ---------------------------------------------------------------------------
_fallback: dict[str, tuple[int, float]] = {}
_fallback_lock = threading.Lock()
_FALLBACK_MAX_IDENTS = 10_000


def _fallback_allow(ident: str, capacity: int, window: int) -> bool:
    now = time.monotonic()
    with _fallback_lock:
        if len(_fallback) > _FALLBACK_MAX_IDENTS:
            for k, (_, start) in list(_fallback.items()):
                if now - start >= window:
                    del _fallback[k]
        count, start = _fallback.get(ident, (0, now))
        if now - start >= window:
            count, start = 0, now
        count += 1
        _fallback[ident] = (count, start)
        return count <= capacity


class TokenBucket:
    """Fixed-window counter over a 60s window. `capacity` is the max requests per window;
    `refill_per_min` is kept for interface symmetry (a fixed window refills fully each minute)."""

    def __init__(self, client: redis_lib.Redis, capacity: int, refill_per_min: int, window_seconds: int = _WINDOW_SECONDS):
        self._r = client
        self._capacity = capacity
        self._window = window_seconds

    def _key(self, ident: str) -> str:
        return f"rl:{ident}"

    async def allow(self, ident: str, *, fail_closed: bool = False) -> bool:
        """True if this request is within the cap; False if it exceeds it (does not raise).

        On a Redis outage the in-process fallback bucket takes over for EVERY class, so some limit
        is always enforced — `proof` is never left unthrottled, and never blanket-denied either.
        `fail_closed` now only decides what happens if even the fallback cannot be consulted.
        """
        key = self._key(ident)
        try:
            pipe = self._r.pipeline()
            pipe.incr(key)
            pipe.ttl(key)
            count, ttl = pipe.execute()
            if ttl == -1:  # counter exists but no TTL yet (first hit) -> set the window
                self._r.expire(key, self._window)
            return int(count) <= self._capacity
        except redis_lib.RedisError as e:
            # Structured marker so ops can alert on `rate_limiter_degraded`.
            logger.warning(
                "rate_limiter_degraded — Redis unreachable, in-process fallback active for %s: %s",
                ident,
                e,
                extra={"event": "rate_limiter_degraded", "ident": ident},
            )
            try:
                return _fallback_allow(ident, self._capacity, self._window)
            except Exception:  # pragma: no cover — the fallback is pure in-memory arithmetic
                logger.error("rate limiter fallback failed for %s", ident)
                return not fail_closed

    def retry_after(self, ident: str) -> int:
        """Seconds until the current window resets (>=1). Safe while Redis is down."""
        try:
            ttl = self._r.ttl(self._key(ident))
        except redis_lib.RedisError:
            return self._window
        return max(int(ttl), 1) if ttl and ttl > 0 else self._window


_CLASS_CAPACITY = {
    "read": lambda s: s.rate_read_per_min,
    "proof": lambda s: s.rate_proof_per_min,
    "validate": lambda s: s.rate_validate_per_min,
}


def _subaccount_budget(request, sub_ref: str, default_capacity: int) -> tuple[int, str | None]:
    """Resolve X-Subaccount to (capacity, subaccount_id).

    Never raises: an unknown or unreadable subaccount falls back to the key-level bucket, because a
    rate limiter must not be the thing that 500s a request. Real validation of the reference happens
    in the handler, where a bad value is a clean 404.
    """
    try:
        from app.repository.models import Subaccount
        from app.repository.session import get_db

        gen = get_db()
        db = next(gen)
        try:
            row = (
                db.query(Subaccount)
                .filter(
                    Subaccount.api_key_id == request.state.api_key_id,
                    (Subaccount.id == sub_ref) | (Subaccount.external_id == sub_ref),
                )
                .first()
            )
            if row is None:
                return default_capacity, None
            return int(row.rate_limit_per_min or default_capacity), row.id
        finally:
            gen.close()
    except Exception:
        return default_capacity, None


def _make_dep(cls: str):
    from fastapi import Request

    async def _dep(request: Request) -> None:
        settings = get_settings()
        capacity = _CLASS_CAPACITY[cls](settings)
        api_key_id = getattr(request.state, "api_key_id", None) or (request.client.host if request.client else "anon")
        ident = f"{cls}:{api_key_id}"

        # Subaccount scoping: one noisy tenant inside an integrator must not exhaust the budget for
        # every other tenant on the same key, so it gets its own bucket and its own capacity.
        sub_ref = request.headers.get("X-Subaccount")
        if sub_ref and getattr(request.state, "api_key_id", None):
            sub_capacity, sub_id = _subaccount_budget(request, sub_ref, capacity)
            if sub_id:
                ident = f"{cls}:{api_key_id}:{sub_id}"
                capacity = sub_capacity

        bucket = TokenBucket(get_redis(), capacity=capacity, refill_per_min=capacity)
        # During a Redis outage every class falls back to the in-process bucket. `proof` additionally
        # denies if even that is unavailable — it burns rapidsnark compute and on-chain spend.
        fail_closed = cls == "proof"
        if not await bucket.allow(ident, fail_closed=fail_closed):
            raise RateLimited(retry_after=bucket.retry_after(ident))

    _dep.__name__ = f"rate_limit_{cls}"
    return _dep


# One stable dependency callable per class, so Depends(rate_limit("read")) is the SAME object every
# time — which lets tests override it via app.dependency_overrides and lets FastAPI de-dupe it.
_DEPS = {cls: _make_dep(cls) for cls in ("read", "proof", "validate")}


def rate_limit(cls: Literal["read", "proof", "validate"]):
    """Return the (stable, memoized) FastAPI dependency enforcing the per-key limit for `cls`.

    Keys the bucket by (api_key_id, class). Over the cap -> raises RateLimited (429 rate_limited +
    Retry-After). api_key_id comes from request.state (set by verify_api_key); falls back to the
    client host for the public health checks.
    """
    return _DEPS[cls]
