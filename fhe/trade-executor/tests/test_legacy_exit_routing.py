from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from web3 import Web3

import evm_executor as evm
from legacy_vaults import resolve_legacy_vault


def test_legacy_vault_resolution_is_a_fixed_server_owned_allowlist(monkeypatch):
    monkeypatch.setenv("BASE_MAINNET_RPC", "https://base.invalid")

    chain = resolve_legacy_vault(8453, "base-legacy-2026-07")

    assert chain.chain_id == 8453
    assert chain.rpc_url == "https://base.invalid"
    assert chain.entrypoint == "0x5433995fc5a0459E5ad7f2A81561384887F37174"


@pytest.mark.parametrize(
    ("chain_id", "generation"),
    [
        (8453, "sepolia-soft-era"),
        (11155111, "base-legacy-2026-07"),
        (8453, "attacker-selected-generation"),
    ],
)
def test_legacy_vault_resolution_rejects_chain_generation_mismatch(chain_id, generation):
    with pytest.raises(ValueError, match="not an approved legacy exit vault"):
        resolve_legacy_vault(chain_id, generation)


def test_legacy_withdraw_uses_soft_era_selector_and_fixed_entrypoint(monkeypatch):
    chain = SimpleNamespace(
        chain_id=8453,
        name="Base legacy exit",
        rpc_url="https://rpc.invalid",
        entrypoint="0x5433995fc5a0459E5ad7f2A81561384887F37174",
    )
    account = SimpleNamespace(address="0x0000000000000000000000000000000000000004")
    w3 = Mock()
    monkeypatch.setattr(
        "requests.post",
        lambda *_args, **_kwargs: SimpleNamespace(json=lambda: {"result": "0x"}),
    )
    sent = Mock(return_value="0x" + "ab" * 32)
    monkeypatch.setattr(evm, "send_tx", sent)

    tx_hash = evm.zk_withdraw_from_legacy_vault(
        w3,
        account,
        chain,
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        "0x0000000000000000000000000000000000000005",
        123,
        {
            "stateRoot": "1",
            "nullifierHashes": ["2"],
            "changeCommitment": "3",
            "pA": ["4", "5"],
            "pB": [["6", "7"], ["8", "9"]],
            "pC": ["10", "11"],
        },
    )

    assert tx_hash == "0x" + "ab" * 32
    tx = sent.call_args.args[2]
    expected_selector = Web3.keccak(
        text="withdraw(address,address,uint256,uint256,uint256[],uint256,uint256[2],uint256[2][2],uint256[2])"
    )[:4]
    assert tx["to"] == chain.entrypoint
    assert tx["data"][:4] == expected_selector
    assert "aspRoot" not in tx

