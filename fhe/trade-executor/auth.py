"""Distributed rate limiting with in-process fallback.

Prefer Redis when REDIS_URL is set (multi-instance safe). Falls back to the
process-local store used historically for single-worker SQLite deploys.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from functools import wraps
from threading import Lock
import os

from flask import request, jsonify

rate_limit_store = defaultdict(list)
rate_limit_lock = Lock()

_redis = None
_redis_failed = False


def _production_env() -> bool:
    env = (os.getenv("SIPHON_ENV") or os.getenv("APP_ENV") or "").strip().lower()
    return env in {"prod", "production"}


def _redis_required() -> bool:
    url = (os.getenv("REDIS_URL") or "").strip()
    return bool(url) and not url.startswith("memory://")


def _get_redis():
    global _redis, _redis_failed
    if _redis_failed:
        return None
    if _redis is not None:
        return _redis
    url = (os.getenv("REDIS_URL") or "").strip()
    if not url:
        return None
    try:
        import redis  # type: ignore

        client = redis.from_url(url, decode_responses=True, socket_connect_timeout=0.5)
        client.ping()
        _redis = client
        return _redis
    except Exception as e:
        print(f"[rate_limit] Redis unavailable, using in-memory fallback: {e}")
        _redis_failed = True
        return None


def get_client_id():
    """Prefer wallet / tag over spoofable X-Client-ID when present."""
    wallet = (request.headers.get("X-Wallet-Address") or "").lower().strip()
    if wallet:
        return f"wallet:{wallet}"
    tag = (request.headers.get("X-Tag") or "").lower().strip()
    if tag:
        return f"tag:{tag}"
    return request.headers.get("X-Client-ID") or request.remote_addr or "unknown"


def _allow_memory(client_id: str, max_requests: int, window_seconds: int) -> bool:
    now = datetime.now()
    window_start = now - timedelta(seconds=window_seconds)
    with rate_limit_lock:
        rate_limit_store[client_id] = [
            t for t in rate_limit_store[client_id] if t > window_start
        ]
        if len(rate_limit_store[client_id]) >= max_requests:
            return False
        rate_limit_store[client_id].append(now)
        return True


def _allow_redis(client_id: str, max_requests: int, window_seconds: int, bucket: str) -> bool | None:
    """Returns True/False if Redis handled the check, None to fall back to memory."""
    r = _get_redis()
    if r is None:
        return None
    key = f"rl:{bucket}:{client_id}"
    try:
        pipe = r.pipeline()
        pipe.incr(key)
        pipe.ttl(key)
        count, ttl = pipe.execute()
        if ttl == -1:
            r.expire(key, window_seconds)
        return int(count) <= max_requests
    except Exception as e:
        print(f"[rate_limit] Redis error, falling back: {e}")
        return None


def check_rate_limit(max_requests: int, window_seconds: int, bucket: str = "default") -> tuple[bool, bool]:
    """Return (allowed, redis_backend_unavailable).

    When REDIS_URL is configured in production but Redis is unreachable, fail closed (503)
    instead of falling back to per-process counters that multiply limits across workers.
    """
    client_id = get_client_id()
    allowed = _allow_redis(client_id, max_requests, window_seconds, bucket)
    if allowed is None:
        if _redis_required() and _production_env():
            return False, True
        return _allow_memory(f"{bucket}:{client_id}", max_requests, window_seconds), False
    return allowed, False


def rate_limit(max_requests=100, window_seconds=60, bucket: str = "default"):
    """Decorator for rate limiting (Redis if configured, else in-memory)."""

    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            allowed, redis_down = check_rate_limit(max_requests, window_seconds, bucket=bucket or f.__name__)
            if redis_down:
                return jsonify({"error": "Rate limit backend unavailable"}), 503
            if not allowed:
                return jsonify({
                    "error": "Rate limit exceeded",
                    "limit": max_requests,
                    "window_seconds": window_seconds,
                }), 429
            return f(*args, **kwargs)

        return decorated_function

    return decorator


def require_auth(f):
    """Decorator to require API token authentication (legacy helper)."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        token = request.headers.get("X-API-TOKEN") or request.headers.get("Authorization")

        if not token:
            return jsonify({"error": "Missing authentication token"}), 401

        if token.startswith("Bearer "):
            token = token[7:]

        expected_token = os.getenv("API_TOKEN", "")
        if not expected_token:
            return jsonify({"error": "Service misconfigured: API_TOKEN not set"}), 500

        if token != expected_token:
            return jsonify({"error": "Invalid authentication token"}), 401

        return f(*args, **kwargs)

    return decorated_function


def require_admin(f):
    """Require the admin token (X-ADMIN-TOKEN header) for allow-list management endpoints."""

    @wraps(f)
    def decorated_function(*args, **kwargs):
        expected = os.getenv("ADMIN_API_TOKEN", "").strip()
        if not expected:
            return jsonify({"error": "Admin API disabled: ADMIN_API_TOKEN not set"}), 503

        token = request.headers.get("X-ADMIN-TOKEN") or request.headers.get("Authorization") or ""
        if token.startswith("Bearer "):
            token = token[7:]
        if token.strip() != expected:
            return jsonify({"error": "Invalid admin token"}), 401

        return f(*args, **kwargs)

    return decorated_function
