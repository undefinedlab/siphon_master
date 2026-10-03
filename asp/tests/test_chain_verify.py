"""Chain verify unit tests (synthetic logs)."""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest

os.environ.setdefault("ASP_DATABASE_URL", "sqlite:///:memory:")

import config
import db
from db import init_db, session
from screen import screen

DEP = "0x1111111111111111111111111111111111111111"


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)
    monkeypatch.setattr(config, "ZKME_MCH_NO", "")
    monkeypatch.setattr(config, "ZKME_API_KEY", "")
    monkeypatch.setattr(config, "ALLOW_ANY_VAULT", False)
    monkeypatch.setattr(config, "SCREEN_ADMIT_RECHECK", False)
    monkeypatch.setattr(config, "SCREEN_ADMIT_MAX_AGE_SEC", 3600)
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


def test_screen_admit_binding():
    from chain_verify import verify_screen_admit_binding

    with patch("screen.is_sanctioned", return_value=False):
        with session() as s:
            screen(
                s,
                chain_id=8453,
                depositor=DEP,
                commitment="999",
                persist=True,
            )
            verify_screen_admit_binding(
                s, commitment="999", chain_id=8453, tx_hash=None, depositor=DEP
            )


def test_screen_binding_rejects_depositor_mismatch():
    from chain_verify import verify_screen_admit_binding

    with patch("screen.is_sanctioned", return_value=False):
        with session() as s:
            screen(s, chain_id=8453, depositor=DEP, commitment="777", persist=True)
            with pytest.raises(ValueError, match="does not match"):
                verify_screen_admit_binding(
                    s,
                    commitment="777",
                    chain_id=8453,
                    tx_hash=None,
                    depositor="0x2222222222222222222222222222222222222222",
                )


def test_vault_match_fail_closed(monkeypatch):
    from chain_verify import _require_vault_match
    from web3 import Web3

    monkeypatch.setattr(config, "vault_kernel_address", lambda chain_id: "")
    monkeypatch.setattr(config, "ALLOW_ANY_VAULT", False)
    monkeypatch.setattr(config, "PRODUCTION_LOCK", False)
    with pytest.raises(ValueError, match="not configured"):
        _require_vault_match(Web3(), "0x" + "a1" * 20, 31337)


def test_screen_binding_denies_pending():
    from chain_verify import verify_screen_admit_binding

    with session() as s:
        from db import ScreenResult, new_decision_id

        s.add(
            ScreenResult(
                decision_id=new_decision_id(),
                chain_id=8453,
                depositor=DEP,
                commitment="888",
                request_json="{}",
                decision="deny",
                reasons="[]",
                addresses_checked="[]",
                deps_json="{}",
                policy_version="test",
            )
        )
        s.commit()
        with pytest.raises(ValueError, match="not admit"):
            verify_screen_admit_binding(
                s, commitment="888", chain_id=8453, tx_hash=None, depositor=DEP
            )
