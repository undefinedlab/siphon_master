"""`GET /set/leaves` — the bulk sync that lets the fire-time prover derive paths locally.

The property under test is not "the endpoint returns data", it is: **a caller that only ever calls
/set/leaves can produce exactly the witness /set/path would have given it**. If that holds, the
enclave never needs a per-label lookup at fire time, and the ASP never sees the real-time query
that would link a deposit label to the spend landing on-chain moments later.

Two failure modes matter and both are silent:
  - leaves served in the wrong ORDER -> a well-formed path that fails the circuit's AspInclusion
    assert, which reads as a proving bug (this is precisely how the insertion-time-path regression
    presented, see test_asp_path_current_root.py).
  - leaves TRUNCATED -> same shape, same misleading failure.
Both are caught here by rebuilding the tree and checking the root, which is what the enclave must
do before trusting anything it derives.
"""
from __future__ import annotations

import os

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
from association_set import admit_label
from core.asp_tree import AspTree, verify_inclusion
from db import init_db, session
from revocation_set import revoke_label


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)
    monkeypatch.setattr(config, "AUTO_PUBLISH_ROOT", False)
    monkeypatch.setattr(config, "SCREEN_TOKEN", "screen-test-token16")
    monkeypatch.setattr(config, "POSTMAN_TOKEN", "postman-test-tok16")
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


@pytest.fixture
def client():
    return app.test_client()


def _headers(token: str = "screen-test-token16") -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _admit(labels: list[int]) -> None:
    # `session()` hands back a raw Session — its context manager closes without committing, so the
    # commit has to be explicit here exactly as it is in the routes (app.py:875 et al).
    with session() as s:
        for label in labels:
            admit_label(s, label=str(label))
        s.commit()


def _revoke(label: int) -> None:
    with session() as s:
        revoke_label(s, label=str(label), reason="test")
        s.commit()


def _leaves(client) -> dict:
    r = client.get("/set/leaves", headers=_headers())
    assert r.status_code == 200, r.get_data(as_text=True)
    return r.get_json()


# --------------------------------------------------------------------------- basics


def test_requires_the_screen_token(poseidon_ready, client):
    assert client.get("/set/leaves").status_code in (401, 403)
    assert client.get("/set/leaves", headers=_headers("wrong-token-000000")).status_code in (401, 403)


def test_empty_set_reports_the_empty_root(poseidon_ready, client):
    data = _leaves(client)
    assert data["admittedLabels"] == []
    assert data["admittedCount"] == 0
    assert data["revokedLabels"] == []
    assert AspTree().root() == int(data["admittedRoot"])


# --------------------------------------------------------------------------- the real property


@pytest.mark.parametrize("n", [1, 2, 3, 5, 8, 9, 17])
def test_every_leaf_is_provable_from_the_bulk_sync_alone(poseidon_ready, client, n):
    """Rebuild from /set/leaves, derive each path locally, verify against the CURRENT root.

    This is the enclave's whole job. It must hold for every leaf, not just the newest — the newest
    always verifies, which is what let the insertion-time-path bug survive.
    """
    labels = [1000 + i for i in range(n)]
    _admit(labels)

    data = _leaves(client)
    assert data["admittedCount"] == n

    tree = AspTree()
    for label in data["admittedLabels"]:
        tree.insert(int(label))

    # The reconstruction must reproduce the served root, or nothing derived from it is trustworthy.
    assert tree.root() == int(data["admittedRoot"]), "rebuilt root != served root"

    for index, label in enumerate(data["admittedLabels"]):
        root, path = tree.path_for_index(index)
        assert root == int(data["admittedRoot"])
        assert verify_inclusion(int(label), root, path, index), f"leaf {index}/{n} not provable"


def test_local_path_is_identical_to_the_one_set_path_serves(poseidon_ready, client):
    """The enclave must not need /set/path at all — same witness, no correlating query."""
    labels = [7001, 7002, 7003, 7004, 7005]
    _admit(labels)
    data = _leaves(client)

    tree = AspTree()
    for label in data["admittedLabels"]:
        tree.insert(int(label))

    for index, label in enumerate(labels):
        served = client.get(f"/set/path?label={label}", headers=_headers()).get_json()
        local_root, local_path = tree.path_for_index(index)

        assert served["leafIndex"] == index
        assert int(served["admittedRoot"]) == local_root
        assert [str(x) for x in local_path.path_elements] == [
            str(x) for x in served["pathElements"]
        ], f"local path elements diverge from /set/path at leaf {index}"
        assert [int(x) for x in local_path.path_indices] == [
            int(x) for x in served["pathIndices"]
        ], f"local path indices diverge from /set/path at leaf {index}"


# --------------------------------------------------------------------------- silent-corruption guards


def test_order_is_leaf_index_order_and_not_sorted(poseidon_ready, client):
    """Order IS the tree. Serving sorted labels would rebuild a DIFFERENT tree with the same members."""
    labels = [900, 100, 500, 300]  # deliberately not ascending
    _admit(labels)
    data = _leaves(client)

    assert [int(x) for x in data["admittedLabels"]] == labels
    assert [int(x) for x in data["admittedLabels"]] != sorted(labels), "fixture must not be pre-sorted"

    # Prove the distinction is load-bearing: the sorted set rebuilds to a different root.
    sorted_tree = AspTree()
    for label in sorted(labels):
        sorted_tree.insert(label)
    assert sorted_tree.root() != int(data["admittedRoot"])


def test_a_truncated_sync_is_detectable_by_the_root_check(poseidon_ready, client):
    """The guard the enclave relies on: a short list must not silently rebuild the right root."""
    _admit([2001, 2002, 2003, 2004])
    data = _leaves(client)

    truncated = AspTree()
    for label in data["admittedLabels"][:-1]:
        truncated.insert(int(label))

    assert truncated.root() != int(data["admittedRoot"]), (
        "a truncated sync produced the served root — the enclave's root check could not detect it"
    )


# --------------------------------------------------------------------------- revocation


def test_revoked_labels_are_reported_and_track_the_revoked_root(poseidon_ready, client):
    _admit([3001, 3002, 3003])
    before = _leaves(client)
    assert before["revokedLabels"] == []

    _revoke(3002)

    after = _leaves(client)
    assert [int(x) for x in after["revokedLabels"]] == [3002]
    assert after["revokedCount"] == 1
    # Revocation is immediate — the revoked root MUST move, or a stale proof would still spend.
    assert after["revokedRoot"] != before["revokedRoot"]
    # Revoking does not remove the label from the admitted tree (separate trees, §ASP).
    assert after["admittedCount"] == 3
    assert after["admittedRoot"] == before["admittedRoot"]


# --------------------------------------------------------------------------- cross-language contract


def test_response_keys_are_pinned(poseidon_ready, client):
    """The enclave prover parses this in Rust (`decryptor/src/spend.rs::AspLeaves`).

    Nothing but this test and its Rust counterpart (`contract_tests::the_asp_set_leaves_response_
    deserializes`) stops a rename here from silently breaking the prover. serde would surface it
    only at fire time, as a strategy that never executes hours after the arming fee was paid.
    """
    _admit([5001, 5002])
    data = _leaves(client)

    required = {
        "admittedRoot",
        "revokedRoot",
        "admittedLabels",
        "admittedCount",
        "revokedLabels",
        "revokedCount",
    }
    # The signed-snapshot fields (see test_snapshot_sig.py) appear only when the response can be
    # bound to one deployment. They are additive: the enclave needs them, plain leaf-set callers
    # ignore them. Nothing else may appear — an unpinned key here is a silent contract change.
    optional = {"issuedAt", "snapshotSig", "snapshotChainId", "snapshotHub"}
    assert required <= set(data)
    assert set(data) - required <= optional
    # Labels cross the wire as decimal STRINGS: these are BN254 field elements and exceed the
    # 2^53 JSON-number range, so any consumer parsing them as numbers loses precision silently.
    assert all(isinstance(x, str) and x.isdigit() for x in data["admittedLabels"])
    assert isinstance(data["admittedRoot"], str) and data["admittedRoot"].isdigit()
    assert isinstance(data["revokedRoot"], str)
    assert isinstance(data["admittedCount"], int)
