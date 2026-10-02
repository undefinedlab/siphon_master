import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import evm_executor as evm


DEPOSITOR = "0x00000000000000000000000000000000000000A1"

# Selectors of the DEPLOYED Entrypoint (Sepolia 0x056E2E88…, Base 0xA8AD713e… — identical
# bytecode). The previous version of this file asserted the tuple against a hardcoded name list,
# which compared the executor to itself: the executor drifted to a 13-field ZKProof, kept
# passing, and every swap reverted on-chain with no revert data because no function matched.
# Pinning the selector makes any future field change fail here instead of in production.
#
# Pinning ONLY swap/swapAndDeposit was itself the same mistake one level up: withdraw() and
# merge() had drifted identically (round 2 inserted _depositor + _changeValue/_mergedValue) and
# were left broken, so every limit order still died with empty revert data. Every entrypoint
# function the executor calls is pinned here now — that is the whole point of the file.
DEPLOYED_SELECTORS = {
    "swap": "0x3dd09719",
    "swapAndDeposit": "0x42ae6816",
    "withdraw": "0x513f08bf",
    "merge": "0xe460645f",
    "deposit": "0x0efe6a8b",
}


def _selector(abi, function_name):
    from eth_utils import function_abi_to_4byte_selector

    function = next(item for item in abi if item.get("name") == function_name)
    return "0x" + function_abi_to_4byte_selector(function).hex()


def test_swap_abis_match_the_deployed_entrypoint_selectors():
    """The executor must call functions that actually exist on-chain."""
    assert _selector(evm.ENTRYPOINT_SWAP_ABI, "swap") == DEPLOYED_SELECTORS["swap"]
    assert (
        _selector(evm.ENTRYPOINT_SWAP_AND_DEPOSIT_ABI, "swapAndDeposit")
        == DEPLOYED_SELECTORS["swapAndDeposit"]
    )


def test_spend_abis_match_the_deployed_entrypoint_selectors():
    """withdraw/merge/deposit — the paths every limit order and consolidation goes through."""
    assert _selector(evm.ENTRYPOINT_ABI, "withdraw") == DEPLOYED_SELECTORS["withdraw"]
    assert _selector(evm.ENTRYPOINT_ABI, "deposit") == DEPLOYED_SELECTORS["deposit"]
    assert _selector(evm.ENTRYPOINT_MERGE_ABI, "merge") == DEPLOYED_SELECTORS["merge"]


def test_hand_rolled_withdraw_selector_matches_the_abi():
    """zk_withdraw_from_vault dry-runs via a hand-built selector, bypassing the ABI entirely.

    That second copy is what actually reverted in production: the ABI could be fixed and the
    eth_call would still probe a non-existent function, turning a real revert reason into
    "empty revert data". Assert the literal signature string keeps matching.
    """
    import inspect
    from eth_utils import keccak

    source = inspect.getsource(evm.zk_withdraw_from_vault)
    signature = next(
        line.split('text="')[1].split('"')[0]
        for line in source.splitlines()
        if 'text="withdraw(' in line
    )
    assert "0x" + keccak(text=signature)[:4].hex() == DEPLOYED_SELECTORS["withdraw"]


def test_change_depositor_is_required_so_the_note_stays_revocable():
    """address(0) would leave the change note unrevocable and unragequittable."""
    proof = {
        "stateRoot": "1", "aspRoot": "2", "newCommitment": "3", "newLabel": "4",
        "recipient": "0x0000000000000000000000000000000000000005",
        "pool": "0x0000000000000000000000000000000000000006",
        "dstToken": "0x0000000000000000000000000000000000000007",
        "fee": "500", "minAmountOut": "8",
        "pA": ["9", "10"], "pB": [["11", "12"], ["13", "14"]], "pC": ["15", "16"],
        "changeValue": "18",
    }
    with pytest.raises(evm.FatalExecutionError, match="changeDepositor"):
        evm._hard_asp_swap_proof_tuple(proof, 17, None)


def test_missing_change_value_fails_closed_rather_than_guessing():
    """Strategies armed before the frontend sent changeValue must be re-armed, not mis-encoded."""
    proof = {
        "stateRoot": "1", "aspRoot": "2", "newCommitment": "3", "newLabel": "4",
        "recipient": "0x0000000000000000000000000000000000000005",
        "pool": "0x0000000000000000000000000000000000000006",
        "dstToken": "0x0000000000000000000000000000000000000007",
        "fee": "500", "minAmountOut": "8",
        "pA": ["9", "10"], "pB": [["11", "12"], ["13", "14"]], "pC": ["15", "16"],
    }
    with pytest.raises(evm.FatalExecutionError, match="changeValue"):
        evm._hard_asp_swap_proof_tuple(proof, 17, DEPOSITOR)


def _tuple_components(abi, function_name):
    function = next(item for item in abi if item.get("name") == function_name)
    tuple_input = next(item for item in function["inputs"] if item["type"] == "tuple")
    return [component["name"] for component in tuple_input["components"]]


def test_v3_swap_abis_match_hard_asp_zkproof_layout():
    expected = [
        "stateRoot",
        "aspRoot",
        "nullifier",
        "newCommitment",
        "newLabel",
        "recipient",
        "pool",
        "dstToken",
        "fee",
        "minAmountOut",
        "pA",
        "pB",
        "pC",
        "changeDepositor",
        "changeValue",
    ]

    assert _tuple_components(evm.ENTRYPOINT_SWAP_ABI, "swap") == expected
    assert _tuple_components(evm.ENTRYPOINT_SWAP_AND_DEPOSIT_ABI, "swapAndDeposit") == expected


def test_hard_asp_swap_tuple_preserves_contract_field_order():
    proof = {
        "stateRoot": "1",
        "aspRoot": "2",
        "newCommitment": "3",
        "newLabel": "4",
        "recipient": "0x0000000000000000000000000000000000000005",
        "pool": "0x0000000000000000000000000000000000000006",
        "dstToken": "0x0000000000000000000000000000000000000007",
        "fee": "500",
        "minAmountOut": "8",
        "pA": ["9", "10"],
        "pB": [["11", "12"], ["13", "14"]],
        "pC": ["15", "16"],
        "changeValue": "18",
    }

    assert evm._hard_asp_swap_proof_tuple(proof, 17, DEPOSITOR) == (
        1,
        2,
        17,
        3,
        4,
        proof["recipient"],
        proof["pool"],
        proof["dstToken"],
        500,
        8,
        [9, 10],
        [[11, 12], [13, 14]],
        [15, 16],
        DEPOSITOR,
        18,
    )


@pytest.mark.parametrize("missing", ["aspRoot", "newLabel"])
def test_hard_asp_swap_tuple_rejects_soft_era_proof(missing):
    proof = {
        "stateRoot": "1",
        "aspRoot": "2",
        "newCommitment": "3",
        "newLabel": "4",
        "recipient": "0x0000000000000000000000000000000000000005",
        "pool": "0x0000000000000000000000000000000000000006",
        "dstToken": "0x0000000000000000000000000000000000000007",
        "fee": "500",
        "minAmountOut": "8",
        "pA": ["9", "10"],
        "pB": [["11", "12"], ["13", "14"]],
        "pC": ["15", "16"],
        "changeValue": "18",
    }
    proof.pop(missing)

    with pytest.raises(evm.FatalExecutionError, match=missing):
        evm._hard_asp_swap_proof_tuple(proof, 17, DEPOSITOR)


def test_v4_hook_payload_matches_hard_asp_swapproof_layout():
    assert evm._SWAP_PROOF_TUPLE == (
        "(uint256,uint256,uint256,uint256,uint256,address,address,uint256,uint256,"
        "uint256,uint256,uint256[2],uint256[2][2],uint256[2])"
    )


def test_merge_abi_requires_asp_root_and_inherited_label():
    merge = next(item for item in evm.ENTRYPOINT_MERGE_ABI if item.get("name") == "merge")
    # Round 2 inserted _depositor + _mergedValue after _asset — they back the merged note's
    # DepositInfo (revocation / ragequit authority), exactly as withdraw gained _depositor and
    # _changeValue. The pinned selector above is the real guard; this documents the order.
    assert [item["name"] for item in merge["inputs"]] == [
        "_asset",
        "_depositor",
        "_mergedValue",
        "_stateRoot",
        "_aspRoot",
        "_nullifierHashes",
        "_mergedCommitment",
        "_mergedLabel",
        "_pA",
        "_pB",
        "_pC",
    ]


def test_contract_abi_constants_are_json_compatible_lists():
    # Guards against accidental hand-edited malformed ABI literals.
    for abi in (
        evm.ENTRYPOINT_SWAP_ABI,
        evm.ENTRYPOINT_SWAP_AND_DEPOSIT_ABI,
        evm.ENTRYPOINT_MERGE_ABI,
    ):
        assert isinstance(json.loads(json.dumps(abi)), list)


def test_merge_submission_uses_hard_asp_argument_order(monkeypatch):
    entrypoint = Mock()
    entrypoint.functions.merge.return_value.build_transaction.return_value = {"data": "merge"}
    w3 = Mock()
    w3.eth.contract.return_value = entrypoint
    account = SimpleNamespace(address="0x0000000000000000000000000000000000000004")
    chain = SimpleNamespace(
        entrypoint="0x0000000000000000000000000000000000000001",
        chain_id=11155111,
        name="Sepolia",
    )
    probe = Mock()
    send = Mock(return_value="0xmerge")
    monkeypatch.setattr(evm, "assert_hard_asp_entrypoint", probe)
    monkeypatch.setattr(evm, "send_tx", send)

    result = evm.zk_merge_from_vault(
        w3,
        account,
        chain,
        "0x0000000000000000000000000000000000000002",
        {
            "stateRoot": "1",
            "aspRoot": "2",
            "nullifierHashes": ["3", "4"],
            "noteCount": 2,
            "mergedCommitment": "5",
            "mergedLabel": "6",
            "mergedValue": "15",
            "pA": ["7", "8"],
            "pB": [["9", "10"], ["11", "12"]],
            "pC": ["13", "14"],
        },
        DEPOSITOR,
    )

    assert result == "0xmerge"
    probe.assert_called_once_with(w3, chain)
    entrypoint.functions.merge.assert_called_once_with(
        "0x0000000000000000000000000000000000000002",
        DEPOSITOR,
        15,
        1,
        2,
        [3, 4],
        5,
        6,
        [7, 8],
        [[9, 10], [11, 12]],
        [13, 14],
    )
    send.assert_called_once_with(
        w3,
        account,
        {"data": "merge"},
        label="zk_merge",
        gas_buffer=1.35,
    )


def test_ceremony_kind_falls_back_to_the_manifest(tmp_path, monkeypatch):
    """An unset ZK_CEREMONY must read CEREMONY.json, exactly like the client does.

    Reading env vars only made the executor stricter than hardAspLive.ts by accident: it treated
    the reviewed round-2 MPC zkeys as dev-beacon and 422'd every Base withdraw, which demoted the
    gasless relayed withdrawal to a raw wallet confirmation popup.
    """
    manifest = tmp_path / "CEREMONY.json"
    manifest.write_text(json.dumps({"kind": "MPC", "status": "reviewed"}))
    monkeypatch.setattr(evm, "_CEREMONY_MANIFEST", str(manifest))
    assert evm._ceremony_kind_from_manifest() == "mpc"


def test_missing_manifest_fails_closed(tmp_path, monkeypatch):
    """No manifest must NOT be read as a pass — the caller falls back to dev-beacon and blocks."""
    monkeypatch.setattr(evm, "_CEREMONY_MANIFEST", str(tmp_path / "absent.json"))
    assert evm._ceremony_kind_from_manifest() == ""


def test_malformed_manifest_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setattr(evm, "_CEREMONY_MANIFEST", str(tmp_path / "bad.json"))
    (tmp_path / "bad.json").write_text("{not json")
    assert evm._ceremony_kind_from_manifest() == ""
