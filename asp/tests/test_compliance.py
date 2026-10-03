"""Pending admit + revoke intake unit tests."""
from __future__ import annotations

import os

import pytest

os.environ["ASP_DATABASE_URL"] = "sqlite:///:memory:"
os.environ["ASP_REQUIRE_SEEDED_LISTS"] = "0"
os.environ["ASP_SCREEN_TOKEN"] = "seal-test-token16"
os.environ["ASP_PENDING_SALT_KEY"] = "seal-test-key"

import config
import db
from association_set import admit_label, is_admitted
from compliance import handle_screen_deny, revoke_if_admitted
from db import init_db, session
from pending_admit import (
    PendingAdmitConflict,
    get_pending_by_commitment,
    read_pending_salt,
    upsert_pending_admit,
)
from revocation_set import is_revoked

DEP_A = "0x1111111111111111111111111111111111111111"
DEP_B = "0x2222222222222222222222222222222222222222"


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setattr(config, "SCREEN_TOKEN", "seal-test-token16")
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


def test_pending_admit_upsert_seals_salt(poseidon_ready):
    with session() as s:
        upsert_pending_admit(
            s,
            chain_id=31337,
            commitment="111",
            user_salt=4242,
            depositor=DEP_A,
        )
        s.commit()
        row = get_pending_by_commitment(s, 31337, "111")
        assert row is not None
        assert row.user_salt.startswith("v1:")
        assert read_pending_salt(row) == "4242"
        assert row.status == "pending"


def test_pending_admit_conflict_different_depositor(poseidon_ready):
    with session() as s:
        upsert_pending_admit(
            s, chain_id=31337, commitment="111", user_salt=1, depositor=DEP_A
        )
        s.commit()
        with pytest.raises(PendingAdmitConflict):
            upsert_pending_admit(
                s, chain_id=31337, commitment="111", user_salt=2, depositor=DEP_B
            )


def test_pending_salt_immutable_same_depositor(poseidon_ready):
    with session() as s:
        upsert_pending_admit(
            s, chain_id=31337, commitment="111", user_salt=1, depositor=DEP_A
        )
        s.commit()
        with pytest.raises(PendingAdmitConflict, match="immutable"):
            upsert_pending_admit(
                s, chain_id=31337, commitment="111", user_salt=2, depositor=DEP_A
            )


def test_revoke_if_admitted(poseidon_ready):
    with session() as s:
        admit_label(s, label="777", chain_id=31337)
        s.commit()
        assert is_admitted(s, "777")
        out = revoke_if_admitted(s, label="777", reason="test")
        s.commit()
        assert out and out.get("revoked") is True
        assert is_revoked(s, "777")
        assert is_admitted(s, "777")


def test_handle_screen_deny_cancels_pending_same_depositor(poseidon_ready):
    with session() as s:
        admit_label(s, label="888", chain_id=1)
        upsert_pending_admit(s, chain_id=1, commitment="55", user_salt=9, depositor=DEP_A)
        s.commit()
        out = handle_screen_deny(
            s,
            chain_id=1,
            commitment="55",
            depositor=DEP_A,
            label="888",
            reasons=["ofac_list"],
        )
        s.commit()
        assert out["cancelledPending"] is True
        assert out["revoked"] is None
        assert is_admitted(s, "888")
        assert not is_revoked(s, "888")
        row = get_pending_by_commitment(s, 1, "55")
        assert row.status == "cancelled"
        assert row.user_salt == ""


def test_handle_screen_deny_skips_other_depositor(poseidon_ready):
    with session() as s:
        upsert_pending_admit(s, chain_id=1, commitment="55", user_salt=9, depositor=DEP_A)
        s.commit()
        out = handle_screen_deny(
            s,
            chain_id=1,
            commitment="55",
            depositor=DEP_B,
            reasons=["ofac_list"],
        )
        s.commit()
        assert out["cancelledPending"] is False
        assert out["skipped"] == "depositor_mismatch"
        row = get_pending_by_commitment(s, 1, "55")
        assert row.status == "pending"
        assert read_pending_salt(row) == "9"
