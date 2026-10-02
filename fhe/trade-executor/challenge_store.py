"""Auth challenge store for short-lived write signatures.

Challenges live in Redis when REDIS_URL is set; otherwise an in-process dict
(fine for single-worker / local dev).
"""
from __future__ import annotations

import os
import secrets
import threading
import time
from typing import Optional

CHALLENGE_TTL_SECONDS = int(os.getenv("AUTH_CHALLENGE_TTL_SECONDS", "300"))

_lock = threading.Lock()
_local: dict[str, tuple[float, str]] = {}  # nonce -> (expires_at epoch, binding)

# What a nonce authorizes. "chain:<id>" = a write signed as `Siphon auth v2:write:<id>:<nonce>`;
# LEGACY = the unbound v1 message (and "1", which pre-binding Redis entries hold). Chain 1 is never
# served, but LEGACY is spelled out anyway so a binding can never be mistaken for a chain id.
LEGACY = "legacy"


def _redis():
    url = (os.getenv("REDIS_URL") or "").strip()
    if not url:
        return None
    try:
        import redis  # type: ignore

        r = redis.from_url(url, decode_responses=True, socket_connect_timeout=0.5)
        r.ping()
        return r
    except Exception:
        return None


def issue_challenge(ttl: Optional[int] = None, chain_id: Optional[int] = None) -> dict:
    ttl = int(ttl or CHALLENGE_TTL_SECONDS)
    nonce = secrets.token_hex(16)
    expires_at = int(time.time()) + ttl
    binding = f"chain:{int(chain_id)}" if chain_id is not None else LEGACY
    out = {"nonce": nonce, "expires_at": expires_at, "ttl_seconds": ttl}
    if chain_id is not None:
        out["chain_id"] = int(chain_id)
    r = _redis()
    if r is not None:
        try:
            r.setex(f"authchal:{nonce}", ttl, binding)
            return out
        except Exception:
            pass
    with _lock:
        _purge_local()
        _local[nonce] = (float(expires_at), binding)
    return out


def take_challenge(nonce: str, *, consume: bool = True) -> Optional[str]:
    """The nonce's binding ("chain:<id>" or LEGACY) if it is live, else None. Single-use when
    `consume`: the binding is read and deleted atomically, so it cannot be checked then swapped."""
    if not nonce:
        return None
    r = _redis()
    if r is not None:
        try:
            key = f"authchal:{nonce}"
            if not consume:
                val = r.get(key)
            elif hasattr(r, "getdel"):
                val = r.getdel(key)
            else:
                pipe = r.pipeline()
                pipe.get(key)
                pipe.delete(key)
                val, _ = pipe.execute()
            if not val:
                return None
            return LEGACY if val in ("1", LEGACY) else str(val)
        except Exception:
            pass
    with _lock:
        _purge_local()
        entry = _local.pop(nonce, None) if consume else _local.get(nonce)
        if entry is None or time.time() > entry[0]:
            return None
        return entry[1]


def consume_challenge(nonce: str) -> bool:
    """Return True if nonce was valid and not yet used (single-use)."""
    return take_challenge(nonce, consume=True) is not None


def peek_challenge(nonce: str) -> bool:
    """True if nonce currently exists (does not consume)."""
    return take_challenge(nonce, consume=False) is not None


def _purge_local():
    now = time.time()
    dead = [k for k, (exp, _b) in _local.items() if exp < now]
    for k in dead:
        _local.pop(k, None)
