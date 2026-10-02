from eth_abi import encode
import pytest

from evm_executor import FatalExecutionError, _extract_nullifier_hashes, decode_revert


def test_preserves_all_multi_note_nullifiers():
    proof = {
        "nullifierHash": "11",
        "nullifierHashes": ["11", "22"],
        "noteCount": 2,
    }

    assert _extract_nullifier_hashes(proof) == [11, 22]


def test_rejects_declared_multi_note_proof_when_array_was_dropped():
    proof = {
        "nullifierHash": "11",
        "noteCount": 2,
    }

    with pytest.raises(FatalExecutionError, match=r"missing nullifierHashes\[\]"):
        _extract_nullifier_hashes(proof)


def test_rejects_note_count_that_disagrees_with_array():
    proof = {
        "nullifierHash": "11",
        "nullifierHashes": ["11", "22"],
        "noteCount": 1,
    }

    with pytest.raises(FatalExecutionError, match="noteCount"):
        _extract_nullifier_hashes(proof)


def test_rejects_array_length_that_disagrees_with_public_signals():
    proof = {
        "nullifierHash": "11",
        "nullifierHashes": ["11"],
        # W2 public signals: amount, root, change, two nullifiers, recipient.
        "publicSignals": ["1", "2", "3", "11", "22", "4"],
    }

    with pytest.raises(FatalExecutionError, match="publicSignals"):
        _extract_nullifier_hashes(proof)


def test_rejects_multi_note_public_signals_when_array_was_dropped():
    proof = {
        "nullifierHash": "11",
        # W2 public signals: amount, root, change, two nullifiers, recipient.
        "publicSignals": ["1", "2", "3", "11", "22", "4"],
    }

    with pytest.raises(FatalExecutionError, match=r"missing nullifierHashes\[\]"):
        _extract_nullifier_hashes(proof)


def test_keeps_legacy_single_note_compatibility():
    assert _extract_nullifier_hashes({"nullifierHash": "11"}) == [11]


@pytest.mark.parametrize(
    ("selector", "name"),
    [
        ("f1d06811", "WithdrawalCostExceedsAmount"),
        ("3489dfb0", "WithdrawalBelowMinimum"),
    ],
)
def test_decodes_withdrawal_fee_errors(selector, name):
    revert_data = bytes.fromhex(selector) + encode(["uint256", "uint256"], [40, 50])

    assert decode_revert(revert_data) == f"Custom error: {name}(40,50)"
