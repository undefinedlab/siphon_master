"""Redis client for ephemeral rate-limit / idempotency keys.

Never the primary datastore (that is Postgres). A single module-level pool is reused across requests.
"""
from __future__ import annotations

import redis

from app.config import get_settings

_client: redis.Redis | None = None


def get_redis() -> redis.Redis:
    """Return the shared Redis client (lazy, decode_responses=True).

    Local-dev escape hatch: `REDIS_URL=memory://` uses in-process fakeredis so packs /
    purchase work without a Redis install. Refused when SIPHON_ENV/APP_ENV is production.
    """
    global _client
    if _client is None:
        settings = get_settings()
        url = (settings.redis_url or "").strip()
        if url.startswith("memory://") or url.lower() in {"fake", "fakeredis"}:
            env = (getattr(settings, "siphon_env", None) or "").strip().lower()
            if env in {"prod", "production"}:
                raise RuntimeError(
                    "REDIS_URL=memory:// is not allowed when SIPHON_ENV/APP_ENV is production"
                )
            import fakeredis

            _client = fakeredis.FakeStrictRedis(decode_responses=True)
        else:
            _client = redis.from_url(
                url,
                decode_responses=True,
                socket_connect_timeout=0.5,
            )
    return _client
