"""VaultKernel.spend relay — input validation and target-address binding.

The relayer only pays gas; every value that moves is a public signal inside the proof. The one
thing it must never do is let the caller choose which contract the proof is aimed at, so the
kernel address comes from server config and a `vaultKernel` in the request body is ignored.
"""
import json

import pytest

import evm_chain_config
from evm_executor import (
    SPEND_PROOF_WIDTH,
    SPEND_COMPLIANCE_WIDTH,
    SPEND_PUBLIC_WIDTH,
    SPEND_SPLIT_OUTPUTS,
    VAULT_KERNEL_SPEND_ABI,
    vault_kernel_spend,
)

PAYEE = "0x" + "11" * 20
KERNEL = "0x" + "ab" * 20
ATTACKER = "0x" + "ee" * 20


def _publics(action=0):
    pi = [0] * SPEND_PUBLIC_WIDTH
    pi[0] = action
    pi[1] = 1
    return pi


def test_abi_matches_the_kernel_signature():
    """spend(uint256[25],uint256[8],uint256[5],uint256[8],(bytes,uint256[8])) — widths are
    load-bearing, and the selector they produce must be the one the deployed kernel exposes.

    The compliance split appends the second proof; it does NOT widen the first vector. labelCommit
    rides publicInputs[24], the one mux slot no action used, so a 26 here would be a silent
    incompatibility with every v4 and v5 kernel alike.
    """
    fn = VAULT_KERNEL_SPEND_ABI[0]
    assert fn["name"] == "spend"
    types = [i["type"] for i in fn["inputs"]]
    assert types == ["uint256[25]", "uint256[8]", "uint256[5]", "uint256[8]", "tuple"]
    tup = [c["type"] for c in fn["inputs"][4]["components"]]
    assert tup == ["bytes", "uint256[8]"]

    from eth_utils import keccak
    sig = "spend(uint256[25],uint256[8],uint256[5],uint256[8],(bytes,uint256[8]))"
    # Selector read off the deployed v5 kernel on Sepolia (0x2631C728…).
    assert keccak(text=sig)[:4].hex() == "4db4ad8f"


def test_chain_config_carries_vault_kernel_separately_from_entrypoint():
    """v1 entrypoint and v2 kernel coexist while v1 vaults still hold funds."""
    cfg = evm_chain_config.get_evm_chain_config(11155111)
    assert hasattr(cfg, "vault_kernel")
    assert cfg.vault_kernel != cfg.entrypoint or cfg.vault_kernel == ""


def test_env_override_sets_the_kernel(monkeypatch):
    monkeypatch.setenv("ETH_SEPOLIA_VAULT_KERNEL", KERNEL)
    assert evm_chain_config.get_evm_chain_config(11155111).vault_kernel == KERNEL


class _Chain:
    chain_id = 11155111
    name = "Ethereum Sepolia"
    vault_kernel = ""


def _cpublics():
    """A well-formed compliance vector. Contents are irrelevant to width validation — the kernel,
    not the relayer, checks that it agrees with the spend half."""
    return [0] * SPEND_COMPLIANCE_WIDTH


def test_refuses_when_no_kernel_configured():
    with pytest.raises(ValueError, match="No VaultKernel configured"):
        vault_kernel_spend(None, None, _Chain(), _publics(), [0] * SPEND_PROOF_WIDTH,
                           _cpublics(), [0] * SPEND_PROOF_WIDTH, b"\x11" * 20)


@pytest.mark.parametrize(
    "publics,proof,payee,expected",
    [
        ([0] * 24, [0] * SPEND_PROOF_WIDTH, b"\x11" * 20, "publicInputs must be 25"),
        (_publics(), [0] * 7, b"\x11" * 20, "proof must be 8"),
        (_publics(), [0] * SPEND_PROOF_WIDTH, b"\x11" * 19, "rawPayee must be 20 bytes"),
    ],
)
def test_rejects_malformed_widths(publics, proof, payee, expected):
    chain = _Chain()
    chain.vault_kernel = KERNEL
    with pytest.raises(ValueError, match=expected):
        vault_kernel_spend(None, None, chain, publics, proof,
                           _cpublics(), [0] * SPEND_PROOF_WIDTH, payee)


def test_rejects_too_many_split_commitments():
    chain = _Chain()
    chain.vault_kernel = KERNEL
    with pytest.raises(ValueError, match="at most 8 splitCommitments"):
        vault_kernel_spend(
            None, None, chain, _publics(3), [0] * SPEND_PROOF_WIDTH,
            _cpublics(), [0] * SPEND_PROOF_WIDTH, b"\x11" * 20,
            split_commitments=[1] * (SPEND_SPLIT_OUTPUTS + 1),
        )


def test_request_body_cannot_choose_the_target_contract():
    """The signature takes the address from `chain`, never from caller-supplied data.

    If someone adds a `vaultKernel` passthrough later, this fails: the parameter list is the
    boundary that keeps a valid proof from being aimed at an attacker's contract.
    """
    import inspect

    params = inspect.signature(vault_kernel_spend).parameters
    assert "vault_kernel" not in params
    assert "chain" in params
