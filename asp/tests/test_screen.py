"""Screening pipeline unit tests (no hop graph, no live oracle)."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("ASP_REQUIRE_AUTH", "0")
os.environ.setdefault("ASP_REQUIRE_SEEDED_LISTS", "0")
os.environ.setdefault("ASP_DATABASE_URL", "sqlite:///:memory:")

import config
import db
from db import init_db, session, upsert_address
from oracle import OracleUnavailable
from screen import screen


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", "sqlite:///:memory:")
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


def test_deny_invalid_depositor():
    with session() as s:
        out = screen(s, chain_id=8453, depositor="not-an-address", persist=False)
    assert out.decision == "deny"
    assert "invalid_depositor" in out.reasons


def test_deny_mixer_hit(monkeypatch):
    monkeypatch.setattr("screen.is_sanctioned", lambda _a, _c: False)
    with session() as s:
        upsert_address(
            s,
            address="0x1111111111111111111111111111111111111111",
            kind="mixer",
            source="test",
        )
        s.commit()
        out = screen(
            s,
            chain_id=8453,
            depositor="0x1111111111111111111111111111111111111111",
            persist=False,
        )
    assert out.decision == "deny"
    assert "mixer" in out.reasons


def test_admit_clean_depositor(monkeypatch):
    monkeypatch.setattr("screen.is_sanctioned", lambda _a, _c: False)
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)
    with session() as s:
        out = screen(
            s,
            chain_id=8453,
            depositor="0x2222222222222222222222222222222222222222",
            commitment="12345",
            persist=False,
        )
    assert out.decision == "admit"
    assert out.commitment == "12345"


def test_oracle_unavailable_denies(monkeypatch):
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)

    def _boom(_a, _c):
        raise OracleUnavailable("rpc down")

    monkeypatch.setattr("screen.is_sanctioned", _boom)
    with session() as s:
        out = screen(
            s,
            chain_id=8453,
            depositor="0x3333333333333333333333333333333333333333",
            persist=False,
        )
    assert out.decision == "deny"
    assert "oracle_unavailable" in out.reasons
