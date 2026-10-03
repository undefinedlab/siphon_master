"""Postman-signed `/set/leaves` snapshots — the TEE's freshness anchor.

The property under test: **the enclave can tell a current snapshot from a replayed one, without
asking its own caller.** Before this, freshness was checked against roots the caller supplied,
which the caller could simply copy from this very response — circular, and load-bearing only
because `spend()` re-checked on-chain. `spendAttested` does not re-check, so the signature and
timestamp here are what stand between a stale revoked set and a revoked note spending.
"""
from __future__ import annotations

import os
import time

import pytest
from eth_account import Account
from eth_utils import keccak

os.environ["ASP_DATABASE_URL"] = "sqlite:///:memory:"
os.environ["ASP_SCREEN_TOKEN"] = "screen-test-token16"
os.environ["ASP_POSTMAN_TOKEN"] = "postman-test-tok16"
os.environ["ASP_REQUIRE_AUTH"] = "1"
os.environ["ASP_AUTO_PUBLISH_ROOT"] = "0"
os.environ["ASP_REQUIRE_SEEDED_LISTS"] = "0"

import config
import db
from app import app
from association_set import admit_label
from db import init_db, session
from snapshot_sig import SNAPSHOT_TYPEHASH, sign_snapshot, snapshot_digest

# One postman identity for the whole module. The key is a throwaway constant, never a real key.
POSTMAN_KEY = "0x" + "11" * 32
POSTMAN_ADDR = Account.from_key(POSTMAN_KEY).address
HUB = "0x667166fe7bfb51fd2b3b9281af0a9dfeb5845288"
CHAIN_ID = 11155111


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)
    monkeypatch.setattr(config, "AUTO_PUBLISH_ROOT", False)
    monkeypatch.setattr(config, "SCREEN_TOKEN", "screen-test-token16")
    monkeypatch.setattr(config, "COMPLIANCE_HUB_BY_CHAIN", {CHAIN_ID: HUB})
    monkeypatch.setenv("ASP_POSTMAN_KEY", POSTMAN_KEY)
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


@pytest.fixture
def client():
    return app.test_client()


def _headers() -> dict:
    return {"Authorization": "Bearer screen-test-token16", "Content-Type": "application/json"}


def _admit(labels: list[int]) -> None:
    with session() as s:
        for label in labels:
            admit_label(s, label=str(label))
        s.commit()


def _recover(digest: bytes, sig_hex: str) -> str:
    raw = bytes.fromhex(sig_hex.removeprefix("0x"))
    assert len(raw) == 65, f"signature must be 65 bytes, got {len(raw)}"
    return Account._recover_hash(digest, vrs=(raw[64], raw[0:32], raw[32:64]))


# --------------------------------------------------------------------------- the cross-language contract


def test_digest_matches_pinned_vector():
    """Pinned byte-for-byte against the Rust twin in `decryptor/src/spend.rs`.

    A silent divergence between the two implementations does not fail here or there — it fails at
    fire time, inside the enclave, as "snapshot signed by the wrong signer". That is hours after
    arming and reads as a key problem rather than an encoding one. This vector is the tripwire.
    """
    assert SNAPSHOT_TYPEHASH.hex() == (
        "e0444d9fddf0a695cb1f67004bcf1b42419979fc456b3b61dde31debdc5b1924"
    )
    digest = snapshot_digest(
        chain_id=CHAIN_ID, hub=HUB, admitted_root=1, revoked_root=2, issued_at=1756300000
    )
    assert digest.hex() == "840c1778b80e883faf9ac559b11ff4b42a70f4a1b6f61d3952b9e0724c16cad4"


def test_signature_matches_pinned_vector():
    sig = sign_snapshot(
        private_key=POSTMAN_KEY,
        chain_id=CHAIN_ID,
        hub=HUB,
        admitted_root=1,
        revoked_root=2,
        issued_at=1756300000,
    )
    assert sig == (
        "0x2dc735a1704af397b94bc2bfca07621898987dee350f71bf768e25477743851776901f28cd58ddcb"
        "193977765efd8ec7c4c34049e631770b184f6e5e2001b1fa1b"
    )
    assert sig.endswith("1b") or sig.endswith("1c"), "v must be 27/28, the form ecrecover accepts"


def test_typehash_is_the_literal_string_it_claims():
    assert SNAPSHOT_TYPEHASH == keccak(
        b"SiphonAspSnapshot(uint256 chainId,address hub,uint256 admittedRoot,"
        b"uint256 revokedRoot,uint256 issuedAt)"
    )


# --------------------------------------------------------------------------- what the digest must bind


@pytest.mark.parametrize(
    "field,other",
    [
        ("chain_id", 8453),
        ("hub", "0x1111111111111111111111111111111111111111"),
        ("admitted_root", 99),
        ("revoked_root", 99),
        ("issued_at", 1756300001),
    ],
)
def test_every_field_binds(field, other):
    """Each field must change the digest. One that does not bind is one an attacker can vary."""
    base = dict(chain_id=CHAIN_ID, hub=HUB, admitted_root=1, revoked_root=2, issued_at=1756300000)
    assert snapshot_digest(**base) != snapshot_digest(**{**base, field: other})


def test_revoked_root_cannot_be_swapped_for_the_admitted_one():
    """Distinct field positions, so (a=1,r=2) and (a=2,r=1) must not collide."""
    a = snapshot_digest(chain_id=CHAIN_ID, hub=HUB, admitted_root=1, revoked_root=2, issued_at=7)
    b = snapshot_digest(chain_id=CHAIN_ID, hub=HUB, admitted_root=2, revoked_root=1, issued_at=7)
    assert a != b


def test_signature_recovers_to_the_postman():
    digest = snapshot_digest(
        chain_id=CHAIN_ID, hub=HUB, admitted_root=5, revoked_root=6, issued_at=1756300000
    )
    sig = sign_snapshot(
        private_key=POSTMAN_KEY,
        chain_id=CHAIN_ID,
        hub=HUB,
        admitted_root=5,
        revoked_root=6,
        issued_at=1756300000,
    )
    assert _recover(digest, sig).lower() == POSTMAN_ADDR.lower()


def test_a_tampered_root_does_not_recover_to_the_postman():
    """The attack this whole file exists to stop: serve real leaves, claim an older revoked root."""
    sig = sign_snapshot(
        private_key=POSTMAN_KEY,
        chain_id=CHAIN_ID,
        hub=HUB,
        admitted_root=5,
        revoked_root=6,
        issued_at=1756300000,
    )
    forged = snapshot_digest(
        chain_id=CHAIN_ID, hub=HUB, admitted_root=5, revoked_root=999, issued_at=1756300000
    )
    assert _recover(forged, sig).lower() != POSTMAN_ADDR.lower()


# --------------------------------------------------------------------------- the route


def test_signed_snapshot_verifies_end_to_end(poseidon_ready, client):
    _admit([4001, 4002, 4003])
    before = int(time.time())
    r = client.get(f"/set/leaves?chainId={CHAIN_ID}", headers=_headers())
    after = int(time.time())
    assert r.status_code == 200, r.get_data(as_text=True)
    data = r.get_json()

    assert data["snapshotChainId"] == CHAIN_ID
    assert data["snapshotHub"] == HUB
    assert before <= data["issuedAt"] <= after, "issuedAt must timestamp THIS response"

    digest = snapshot_digest(
        chain_id=data["snapshotChainId"],
        hub=data["snapshotHub"],
        admitted_root=int(data["admittedRoot"]),
        revoked_root=int(data["revokedRoot"]),
        issued_at=data["issuedAt"],
    )
    assert _recover(digest, data["snapshotSig"]).lower() == POSTMAN_ADDR.lower()


def test_the_signature_tracks_the_roots_it_is_served_with(poseidon_ready, client):
    """Admitting moves the admitted root; the signature must follow, not stay valid for the old one."""
    _admit([5001])
    first = client.get(f"/set/leaves?chainId={CHAIN_ID}", headers=_headers()).get_json()
    _admit([5002])
    second = client.get(f"/set/leaves?chainId={CHAIN_ID}", headers=_headers()).get_json()

    assert first["admittedRoot"] != second["admittedRoot"]
    assert first["snapshotSig"] != second["snapshotSig"]

    # The old signature must not validate against the new roots.
    stale_digest = snapshot_digest(
        chain_id=CHAIN_ID,
        hub=HUB,
        admitted_root=int(second["admittedRoot"]),
        revoked_root=int(second["revokedRoot"]),
        issued_at=first["issuedAt"],
    )
    assert _recover(stale_digest, first["snapshotSig"]).lower() != POSTMAN_ADDR.lower()


def test_revocation_moves_the_signature(poseidon_ready, client):
    """Revocation is the immediate path — a signature minted before it must not cover after it."""
    from revocation_set import revoke_label

    _admit([6001, 6002])
    before = client.get(f"/set/leaves?chainId={CHAIN_ID}", headers=_headers()).get_json()
    with session() as s:
        revoke_label(s, label="6002", reason="test")
        s.commit()
    after = client.get(f"/set/leaves?chainId={CHAIN_ID}", headers=_headers()).get_json()

    assert before["revokedRoot"] != after["revokedRoot"]
    assert before["snapshotSig"] != after["snapshotSig"]


def test_unknown_chain_is_a_loud_400_not_a_silent_unsigned_body(poseidon_ready, client):
    r = client.get("/set/leaves?chainId=999999", headers=_headers())
    assert r.status_code == 400
    assert r.get_json()["error"] == "no_compliance_hub_for_chain"


def test_omitting_chain_id_still_serves_the_leaf_sets(poseidon_ready, client):
    """Back-compat: callers that only want the leaves keep working."""
    _admit([7001])
    data = client.get("/set/leaves", headers=_headers()).get_json()
    assert data["admittedCount"] == 1
    # Exactly one hub is configured here, so it can still bind unambiguously.
    assert data["snapshotChainId"] == CHAIN_ID


def test_ambiguous_hub_config_serves_unsigned_rather_than_guessing(poseidon_ready, client, monkeypatch):
    """Two hubs and no chainId: signing for the wrong deployment is worse than not signing."""
    monkeypatch.setattr(config, "COMPLIANCE_HUB_BY_CHAIN", {CHAIN_ID: HUB, 8453: HUB})
    data = client.get("/set/leaves", headers=_headers()).get_json()
    assert "snapshotSig" not in data
    assert "issuedAt" not in data


def test_still_requires_the_screen_token(poseidon_ready, client):
    assert client.get(f"/set/leaves?chainId={CHAIN_ID}").status_code in (401, 403)
