"""Postman publish helpers — dry-run and skip paths."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("ASP_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ASP_REQUIRE_AUTH", "0")

import db
import postman
from db import init_db


@pytest.fixture(autouse=True)
def fresh_db():
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


def test_publish_admitted_dry_run():
    out = postman.publish_admitted_root(chain_id=31337, dry_run=True)
    assert out["dryRun"] is True
    assert "admittedRoot" in out


def test_publish_revoked_dry_run():
    out = postman.publish_revoked_root(chain_id=31337, dry_run=True)
    assert out["dryRun"] is True
    assert "revokedRoot" in out


def test_reconcile_without_rpc(monkeypatch):
    monkeypatch.setattr(postman, "read_onchain_roots", lambda chain_id=None: None)
    out = postman.reconcile(chain_id=31337)
    assert out["ok"] is False
    assert out["error"] == "onchain_unavailable"


def test_reconcile_clears_stale_pending(monkeypatch):
    from association_set import current_admitted_root, mark_admitted_published
    from db import META_PENDING_ADMIT_PUBLISH, get_meta, session, set_meta
    from revocation_set import current_revoked_root

    with session() as db:
        admitted = current_admitted_root(db)
        revoked = current_revoked_root(db)
        set_meta(db, META_PENDING_ADMIT_PUBLISH, "1")
        db.commit()

    monkeypatch.setattr(
        postman,
        "read_onchain_roots",
        lambda chain_id=None: {"admittedRoot": admitted, "revokedRoot": revoked},
    )
    out = postman.reconcile(chain_id=31337)
    assert out["ok"] is True
    assert out["drift"]["admitted"] is False
    with session() as db:
        assert get_meta(db, META_PENDING_ADMIT_PUBLISH) != "1"


def test_send_does_not_sign_a_reverting_publish():
    class Reverts:
        def call(self, tx):
            raise RuntimeError("execution reverted: RevokeRootReused")

        def build_transaction(self, tx):  # pragma: no cover - must not be reached
            raise AssertionError("built a tx the hub would revert")

    class Acct:
        address = "0x0000000000000000000000000000000000000001"

    with pytest.raises(RuntimeError, match="RevokeRootReused"):
        postman._send(None, Acct(), Reverts(), 200_000)
