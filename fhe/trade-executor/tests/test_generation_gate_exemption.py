"""The vault-generation policy and its exemption have to agree at BOTH gates.

They did not: `run_execution` learned to exempt attested v3 spends while the arming gate in
`create_strategy` kept applying the policy, so every v3 arm was refused with "These funds are in
an older vault" — the client injects `vault_generation_id` from its own network config on every
chain, so a v3 arm names the retired v1 generation while the funds sit in the kernel.
"""
from types import SimpleNamespace

import pytest

import vault_generation

V3_CHAIN = 11155111


@pytest.fixture
def kernel_on_v3_chain(monkeypatch):
    import evm_chain_config

    monkeypatch.setattr(
        evm_chain_config,
        "get_evm_chain_config",
        lambda cid: SimpleNamespace(
            chain_id=int(cid),
            vault_kernel="0x50Db1b65fe56de4015912FD3E1AdC1bccFB08151" if int(cid) == V3_CHAIN else "",
        ),
    )


def test_a_proofless_v3_arm_is_exempt_from_the_generation_policy(kernel_on_v3_chain):
    armed = {"from_chain": V3_CHAIN, "strategy_type": "LIMIT_SELL", "vault_generation_id": "retired-v1"}

    assert vault_generation.is_attested_strategy(armed) is True
    # Without the exemption this is what the arming gate returned.
    assert vault_generation.validate_strategy_generation(armed)["ok"] is False


def test_a_v2_multileg_payload_is_not_attested(kernel_on_v3_chain):
    """A v2 TWAP/grid carries proofs ONLY on its legs.

    A top-level-only proof test reads that as attested and waves the whole payload past the
    policy — on a chain that has a kernel, which is exactly where it matters.
    """
    twap = {
        "from_chain": V3_CHAIN,
        "vault_generation_id": "retired-v1",
        "legs": [{"leg_index": 0, "zk_proof": {"pi_a": ["1"]}}, {"leg_index": 1, "zk_proof": {"pi_a": ["2"]}}],
    }

    assert vault_generation.is_attested_strategy(twap) is False


def test_a_v3_multileg_payload_is_attested(kernel_on_v3_chain):
    """The v3 counterpart: legs present, no proof on any of them."""
    twap = {
        "from_chain": V3_CHAIN,
        "legs": [{"leg_index": 0, "output_precommitment": "0x1"}, {"leg_index": 1, "output_precommitment": "0x2"}],
    }

    assert vault_generation.is_attested_strategy(twap) is True


def test_a_proofless_row_on_a_chain_without_a_kernel_is_not_exempt(kernel_on_v3_chain):
    """A pre-upgrade row has no proof either — the policy exists to reject exactly those."""
    assert vault_generation.is_attested_strategy({"from_chain": 8453}) is False


def test_the_exempt_decision_has_the_same_shape_as_a_policy_decision(kernel_on_v3_chain):
    """Both branches feed the same caller, which reads generation_id off the result.

    The exempt branch once returned a bare {"ok": True} and the arm 500'd on
    KeyError('generation_id') at the row write — after the fee had already been taken.
    """
    exempt = vault_generation.generation_decision({"from_chain": V3_CHAIN})
    policed = vault_generation.generation_decision(
        {"from_chain": 8453, "vault_generation_id": "whatever", "zk_proof": {"pi_a": ["1"]}}
    )

    assert exempt.keys() == policed.keys() == {"ok", "code", "generation_id"}
    assert exempt["ok"] is True


def test_an_attested_strategy_records_its_kernel_as_the_generation(kernel_on_v3_chain):
    """`v3-<kernel>` is the identity the note rows carry in vault_id, so the row stays joinable.

    It comes from server config — a payload naming a different kernel cannot change what is
    written.
    """
    decision = vault_generation.generation_decision(
        {"from_chain": V3_CHAIN, "vault_generation_id": "retired-v1"}
    )

    assert decision["generation_id"] == "v3-0x50Db1b65fe56de4015912FD3E1AdC1bccFB08151"


def test_executor_runner_and_the_arming_gate_share_one_predicate():
    """Rebind the names and the two gates can drift apart again."""
    import executor_runner

    assert executor_runner._is_attested_strategy is vault_generation.is_attested_strategy
    assert executor_runner._strategy_chain_id is vault_generation.strategy_chain_id
