"""Association set DB tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("ASP_REQUIRE_AUTH", "0")
os.environ.setdefault("ASP_DATABASE_URL", "sqlite:///:memory:")

import config
import db
from association_set import admit_label, get_admitted_path, is_admitted
from db import init_db, session


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", "sqlite:///:memory:")
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


def test_admit_and_path(poseidon_ready):
    with session() as s:
        r = admit_label(s, label="424242", chain_id=8453, vault_address="0x" + "a1" * 20)
        s.commit()
        assert r["admitted"] is True
        assert is_admitted(s, "424242")
        path = get_admitted_path(s, "424242")
    assert path is not None
    assert path.leaf_index == 0
    assert len(path.path_elements) == 32


def test_admit_idempotent(poseidon_ready):
    with session() as s:
        admit_label(s, label="999", chain_id=1)
        s.commit()
        r2 = admit_label(s, label="999", chain_id=1)
    assert r2.get("already") is True
