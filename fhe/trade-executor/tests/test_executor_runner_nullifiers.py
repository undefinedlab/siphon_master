from executor_runner import (
    _claim_nullifiers,
    _get_nullifier_hashes,
    _reconcile_spent_nullifiers,
    run_execution,
)


def test_gets_every_nullifier_from_multi_note_proof():
    strategy = {
        "zkp_data": {
            "nullifierHash": "11",
            "nullifierHashes": ["11", "22"],
        }
    }

    assert _get_nullifier_hashes(strategy) == ["11", "22"]


def test_keeps_legacy_singular_nullifier_compatibility():
    assert _get_nullifier_hashes({"zkp_data": {"nullifierHash": "11"}}) == ["11"]


def test_claims_every_nullifier(monkeypatch):
    claimed = []

    def claim(nullifier_hash, commitment_id):
        claimed.append((nullifier_hash, commitment_id))
        return True

    monkeypatch.setattr("executor_runner._claim_nullifier", claim)
    monkeypatch.setattr("executor_runner._release_nullifier", lambda _: None)

    assert _claim_nullifiers(["11", "22"], "commitment-1") is True
    assert claimed == [("11", "commitment-1"), ("22", None)]


def test_rolls_back_earlier_claims_when_later_claim_fails(monkeypatch):
    released = []
    monkeypatch.setattr(
        "executor_runner._claim_nullifier",
        lambda nullifier_hash, _: nullifier_hash != "22",
    )
    monkeypatch.setattr("executor_runner._release_nullifier", released.append)

    assert _claim_nullifiers(["11", "22"], "commitment-1") is False
    assert released == ["11"]


def test_reconciles_only_nullifiers_confirmed_spent_on_chain(monkeypatch):
    spent = []
    released = []
    monkeypatch.setattr("executor_runner._mark_nullifier_spent", spent.append)
    monkeypatch.setattr("executor_runner._release_nullifier", released.append)

    _reconcile_spent_nullifiers(["11", "22"], ["11"])

    assert spent == ["11"]
    assert released == ["22"]


def test_reconciliation_failure_keeps_every_claim_pending(monkeypatch):
    spent = []
    released = []
    monkeypatch.setattr("executor_runner._mark_nullifier_spent", spent.append)
    monkeypatch.setattr("executor_runner._release_nullifier", released.append)

    _reconcile_spent_nullifiers(["11", "22"], None)

    assert spent == []
    assert released == []


def test_execution_rejects_pre_upgrade_row_before_claiming_anything(monkeypatch):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-hard-asp-v1")
    result = run_execution({"id": "old-row", "from_chain": "8453", "is_private": True}, 1.0)
    assert result["status"] == "FAILED"
    assert result["error_code"] == "VAULT_GENERATION_REQUIRED"
