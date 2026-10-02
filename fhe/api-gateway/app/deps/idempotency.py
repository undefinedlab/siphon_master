"""Idempotency — Postgres-authoritative, crash-safe (spec §5.3).

Postgres `idempotency_keys` is the source of truth (durability > latency for money ops); Redis is
only a read-through cache in front of it (not wired here — a later optimization, never a second
source of truth). Crash semantics: the row is written `in_progress` BEFORE the side effect; a retry
that finds `in_progress` gets 409 (client backs off) and does NOT re-execute; it flips to `completed`
with the stored response only after the side effect commits.

Usage:

    with idempotent(db, key, body) as ctx:
        if ctx.stored is not None:
            return ctx.stored           # (status_code, response_body) — replayed, no re-execute
        ... do the side effect ...
        ctx.store(status_code, response_body)
        return status_code, response_body
"""
import hashlib
import json
from contextlib import contextmanager

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import IdempotencyKeyReuse, RequestInProgress
from app.repository.models import IdempotencyKey


def request_hash(body: dict | None) -> str:
    """Stable, order-independent hash of a request body."""
    canonical = json.dumps(body or {}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


class _Ctx:
    def __init__(self, db: Session, key: str | None):
        self._db = db
        self._key = key
        self.stored: tuple[int, dict] | None = None

    def store(self, status_code: int, response_body: dict) -> None:
        """Persist the response and mark the operation completed (called after the side effect)."""
        if self._key is None:
            return
        row = self._db.get(IdempotencyKey, self._key)
        if row is not None:
            row.status = "completed"
            row.status_code = status_code
            row.response_body = response_body
            self._db.flush()


def request_scope(request, *, wallet: str | None = None) -> str:
    """Tenant, signer, method and route namespace for a caller-supplied idempotency key."""
    api_key_id = getattr(request.state, "api_key_id", "")
    return "\0".join(
        (str(api_key_id), (wallet or "").lower(), request.method.upper(), request.url.path)
    )


def scoped_idempotency_key(scope: str, key: str) -> str:
    """Opaque downstream correlation id; never disclose the tenant id or caller's raw key."""
    return hashlib.sha256(f"{scope}\0{key}".encode()).hexdigest()


@contextmanager
def idempotent(
    db: Session, key: str | None, body: dict | None, *, scope: str | None = None
):
    """Guard a money-moving operation by Idempotency-Key. See module docstring for semantics."""
    if not key:
        yield _Ctx(db, None)  # unguarded pass-through
        return

    # Caller keys are not globally unique. Hash the server-controlled tenant/route namespace into
    # the stored key so two businesses using `request-1` cannot receive each other's response.
    stored_key = scoped_idempotency_key(scope, key) if scope else key
    rhash = request_hash(body)
    existing = db.execute(
        select(IdempotencyKey).where(IdempotencyKey.key == stored_key)
    ).scalar_one_or_none()

    if existing is None and scope:
        # Safe cutover from the former global namespace. We cannot prove which tenant owns a
        # legacy row, so never return its response and never repeat its possible side effect.
        legacy = db.execute(
            select(IdempotencyKey).where(IdempotencyKey.key == key)
        ).scalar_one_or_none()
        if legacy is not None:
            raise IdempotencyKeyReuse(
                "This Idempotency-Key exists in the retired global namespace; use a new key."
            )

    if existing is not None:
        if existing.request_hash != rhash:
            raise IdempotencyKeyReuse("Idempotency-Key reused with a different request body.")
        if existing.status == "completed":
            ctx = _Ctx(db, stored_key)
            ctx.stored = (existing.status_code, existing.response_body)
            yield ctx
            return
        # in_progress -> a concurrent/crashed request holds this key
        raise RequestInProgress("A request with this Idempotency-Key is already in progress.")

    # First time: reserve the key in_progress BEFORE the side effect.
    db.add(IdempotencyKey(key=stored_key, request_hash=rhash, status="in_progress"))
    db.flush()
    yield _Ctx(db, stored_key)
