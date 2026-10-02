"""Idempotency — Postgres-authoritative, crash-safe (spec §5.3).

The `idempotent` context manager writes an in_progress row before the side effect, returns the
stored response on a duplicate, 422 on same-key-different-body, 409 on an in-flight row.
"""
import hashlib
import json

import pytest

from app.deps.idempotency import idempotent, request_hash
from app.errors import IdempotencyKeyReuse, RequestInProgress
from app.repository.models import IdempotencyKey


def _run_once(db, key, body, effect_counter, status=200, resp=None):
    resp = resp or {"ok": True}
    with idempotent(db, key, body) as ctx:
        if ctx.stored is not None:
            return ctx.stored
        effect_counter.append(1)  # the "side effect"
        ctx.store(status, resp)
        return status, resp


def test_no_key_passes_through(db_session):
    effects = []
    with idempotent(db_session, None, {"a": 1}) as ctx:
        assert ctx.stored is None
        effects.append(1)
        ctx.store(200, {"ok": True})
    assert len(effects) == 1
    # nothing persisted when there's no key
    assert db_session.query(IdempotencyKey).count() == 0


def test_duplicate_same_body_returns_stored_and_runs_once(db_session):
    effects = []
    s1, b1 = _run_once(db_session, "k1", {"a": 1}, effects)
    s2, b2 = _run_once(db_session, "k1", {"a": 1}, effects)
    assert (s1, b1) == (s2, b2)
    assert len(effects) == 1  # side effect executed exactly once


def test_same_key_different_body_is_422(db_session):
    effects = []
    _run_once(db_session, "k2", {"a": 1}, effects)
    with pytest.raises(IdempotencyKeyReuse):
        _run_once(db_session, "k2", {"a": 2}, effects)


def test_in_progress_row_is_409(db_session):
    # simulate a crash mid-flight: an in_progress row exists, never completed
    db_session.add(IdempotencyKey(key="k3", request_hash=request_hash({"a": 1}), status="in_progress"))
    db_session.commit()
    with pytest.raises(RequestInProgress):
        with idempotent(db_session, "k3", {"a": 1}):
            pass


def test_request_hash_is_stable_and_order_independent():
    assert request_hash({"a": 1, "b": 2}) == request_hash({"b": 2, "a": 1})
    assert request_hash({"a": 1}) != request_hash({"a": 2})
