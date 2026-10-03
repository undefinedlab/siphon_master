"""Exit ticket: revoking a never-admitted label when it is PROVEN to be a real deposit.

PROTOCOL §5.2.1 lists "pre-admit exit | label ∉ ASP (typical) | label ∈ SMT | Revoked" as a
normative journey, and F-8 calls it an "ops exit ticket". The is_admitted() guard on /set/revoke
forbade exactly that row, which left anyone denied at the admit-time recheck with no exit at all:
deposit() is permissionless on-chain, RAGEQUIT branch0 needs an EMPTY admittedRoot (already
burned — seenAdmittedRoots(EMPTY) is true on Sepolia), and branch1 needs SMT inclusion the ASP
refused to grant.

The anti-pollution property F-4 was protecting is kept by PROVING the label from a Deposited
event instead of assuming it, so arbitrary field elements still cannot enter the SMT.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

import config
import db
from app import app
from core.label import derive_deposit_label
from db import init_db

HDR = {"Authorization": "Bearer postman-test-tok16", "Content-Type": "application/json"}
CHAIN = 31337
VAULT = "0x" + "a1" * 20
SALT = 424242
NONCE = 11


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setattr(config, "POSTMAN_TOKEN", "postman-test-tok16")
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)
    monkeypatch.setattr(config, "AUTO_PUBLISH_ROOT", False)
    monkeypatch.setattr(config, "ALLOW_ANY_VAULT", False)
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


@pytest.fixture
def client():
    return app.test_client()


def _label() -> str:
    return str(
        derive_deposit_label(
            chain_id=CHAIN, vault_address=VAULT, deposit_nonce=NONCE, user_salt=SALT
        )
    )


def _dep_event(depositor="0x" + "22" * 20):
    return {
        "depositor": depositor, "token": "0x" + "33" * 20, "amount": "1000",
        "commitment": "12345", "depositNonce": NONCE, "stateRootAfter": "1",
        "vault": VAULT, "chainId": CHAIN,
    }


def test_exit_ticket_revokes_unadmitted_label(poseidon_ready, client, monkeypatch):
    """The whole point: a real deposit that was never admitted can still be given its way out."""
    monkeypatch.setattr(config, "ALLOW_REVOKE_UNADMITTED", False)
    with patch("app.verify_deposited", return_value=_dep_event()):
        r = client.post("/set/revoke", headers=HDR, json={
            "txHash": "0x" + "ab" * 32, "chainId": CHAIN, "vault": VAULT,
            "userSalt": str(SALT), "reason": "pre_admit_exit",
        })
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    assert body.get("revoked") is True
    assert body["label"] == _label()


def test_exit_ticket_still_rejects_unproven_labels(poseidon_ready, client, monkeypatch):
    """F-4 must survive: no txHash means no SMT write for a label that was never admitted."""
    monkeypatch.setattr(config, "ALLOW_REVOKE_UNADMITTED", False)
    r = client.post("/set/revoke", headers=HDR, json={"label": "999123", "reason": "pollute"})
    assert r.status_code == 400
    assert r.get_json()["error"] == "not_admitted"


def test_exit_ticket_rejects_label_that_does_not_match_the_deposit(poseidon_ready, client, monkeypatch):
    """A caller cannot smuggle in an unrelated label alongside a valid deposit proof."""
    monkeypatch.setattr(config, "ALLOW_REVOKE_UNADMITTED", False)
    with patch("app.verify_deposited", return_value=_dep_event()):
        r = client.post("/set/revoke", headers=HDR, json={
            "label": "999124", "txHash": "0x" + "ab" * 32, "chainId": CHAIN,
            "vault": VAULT, "userSalt": str(SALT),
        })
    assert r.status_code == 400
    assert r.get_json()["error"] == "label_mismatch"


def test_exit_ticket_rejects_unverifiable_tx(poseidon_ready, client, monkeypatch):
    """No Deposited event at the pinned vault → no exit ticket."""
    monkeypatch.setattr(config, "ALLOW_REVOKE_UNADMITTED", False)
    with patch("app.verify_deposited", side_effect=ValueError("Deposited event not found in tx for vault")):
        r = client.post("/set/revoke", headers=HDR, json={
            "txHash": "0x" + "cd" * 32, "chainId": CHAIN, "vault": VAULT, "userSalt": str(SALT),
        })
    assert r.status_code == 400
    assert r.get_json()["error"] == "chain_verify_failed"
