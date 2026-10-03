"""Flask /set/* integration tests."""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest

os.environ["ASP_DATABASE_URL"] = "sqlite:///:memory:"
os.environ["ASP_SCREEN_TOKEN"] = "screen-test-token16"
os.environ["ASP_POSTMAN_TOKEN"] = "postman-test-tok16"
os.environ["ASP_REQUIRE_AUTH"] = "1"
os.environ["ASP_AUTO_PUBLISH_ROOT"] = "0"
os.environ["ASP_REQUIRE_SEEDED_LISTS"] = "0"

import config
import db
from app import app
from core.label import derive_deposit_label
from db import init_db, session
from screen import screen


VAULT = "0x" + "a1" * 20
DEPOSITOR = "0x2222222222222222222222222222222222222222"
SALT = 4242


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)
    monkeypatch.setattr(config, "AUTO_PUBLISH_ROOT", False)
    monkeypatch.setattr(config, "SCREEN_TOKEN", "screen-test-token16")
    monkeypatch.setattr(config, "POSTMAN_TOKEN", "postman-test-tok16")
    monkeypatch.setattr(config, "REQUIRE_USER_SALT", True)
    monkeypatch.setattr(config, "ALLOW_CLIENT_LABEL", False)
    monkeypatch.setattr(config, "ZKME_MCH_NO", "")
    monkeypatch.setattr(config, "ZKME_API_KEY", "")
    monkeypatch.setattr(config, "SCREEN_ADMIT_RECHECK", False)
    monkeypatch.setattr(config, "SCREEN_ADMIT_MAX_AGE_SEC", 3600)
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


@pytest.fixture
def client():
    return app.test_client()


def _headers(token: str = "screen-test-token16") -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def test_set_root_empty(poseidon_ready, client):
    r = client.get("/set/root", headers=_headers())
    assert r.status_code == 200
    data = r.get_json()
    assert "admittedRoot" in data
    assert "revokedRoot" in data


def test_metrics(poseidon_ready, client):
    r = client.get("/metrics", headers=_headers())
    assert r.status_code == 200
    data = r.get_json()
    assert "counters" in data
    assert "pendingAdmitOutbox" in data


def test_admit_requires_user_salt(poseidon_ready, client):
    r = client.post(
        "/set/admit",
        headers={"Authorization": "Bearer postman-test-tok16", "Content-Type": "application/json"},
        json={
            "label": "424242",
            "txHash": "0x" + "ab" * 32,
            "vault": VAULT,
            "chainId": 31337,
            "commitment": "12345",
        },
    )
    assert r.status_code == 400
    assert r.get_json()["error"] == "userSalt_required"


@patch("app.verify_deposited")
@patch("screen.is_sanctioned", return_value=False)
def test_set_admit_flow(mock_oracle, mock_verify, poseidon_ready, client):
    mock_verify.return_value = {
        "depositor": DEPOSITOR,
        "commitment": "12345",
        "depositNonce": 1,
        "amount": "1000",
        "stateRootAfter": "1",
        "vault": VAULT,
        "chainId": 31337,
    }
    label = str(
        derive_deposit_label(
            chain_id=31337,
            vault_address=VAULT,
            deposit_nonce=1,
            user_salt=SALT,
        )
    )
    with session() as s:
        screen(s, chain_id=31337, depositor=DEPOSITOR, commitment="12345", persist=True)

    r = client.post(
        "/set/admit",
        headers={"Authorization": "Bearer postman-test-tok16", "Content-Type": "application/json"},
        json={
            "userSalt": str(SALT),
            "txHash": "0x" + "ab" * 32,
            "vault": VAULT,
            "chainId": 31337,
            "commitment": "12345",
        },
    )
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["admitted"] is True
    assert r.get_json()["label"] == label

    path_r = client.get(f"/set/path?label={label}", headers=_headers())
    assert path_r.status_code == 200
    assert len(path_r.get_json()["pathElements"]) == 32


@patch("screen.is_sanctioned", return_value=True)
def test_screen_deny_cancels_pending(mock_oracle, poseidon_ready, client):
    # First admit-path screen with salt stores pending
    with patch("screen.is_sanctioned", return_value=False):
        r1 = client.post(
            "/screen",
            headers=_headers(),
            json={
                "chainId": 31337,
                "depositor": DEPOSITOR,
                "commitment": "999",
                "userSalt": str(SALT),
                "vault": VAULT,
            },
        )
    assert r1.status_code == 200
    assert r1.get_json().get("pendingAdmit") is True

    # Deny re-screen cancels pending
    r2 = client.post(
        "/screen",
        headers=_headers(),
        json={
            "chainId": 31337,
            "depositor": DEPOSITOR,
            "commitment": "999",
            "userSalt": str(SALT),
        },
    )
    assert r2.status_code == 200
    assert r2.get_json()["decision"] == "deny"
    assert r2.get_json().get("compliance", {}).get("cancelledPending") is True
