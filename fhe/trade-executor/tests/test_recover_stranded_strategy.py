import pytest
from types import SimpleNamespace
from unittest.mock import Mock

import recover_stranded_strategy as recovery
import transaction_policy
from recover_stranded_strategy import (
    RecoveryAmounts,
    _confirm_prepared_action,
    _force_pool_price_allowed,
    _pool_relative_minimum,
    _plan_identity,
    _revoke_router_allowance,
    _validate_withdraw_call,
)


def test_recovery_amount_uses_receipt_payout_not_proof_or_pooled_balance():
    amounts = RecoveryAmounts.from_receipt(
        proof_amount=1_000_000_000,
        receipt_payout=993_500_000,
        unswept_execution_fees=[2_000_053],
    )

    assert amounts.vault_fee == 6_500_000
    assert amounts.execution_fee == 2_000_053
    assert amounts.swap_amount == 991_499_947


def test_recovery_rejects_fees_that_exhaust_the_receipt_payout():
    with pytest.raises(ValueError, match="no recoverable payout remains"):
        RecoveryAmounts.from_receipt(
            proof_amount=1_000_000_000,
            receipt_payout=2_000_053,
            unswept_execution_fees=[2_000_053],
        )


def test_withdrawal_must_match_the_strategy_proof_nullifier():
    chain = SimpleNamespace(usdc="0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238")
    executor = "0xc5b7b574EE84A9B59B475FE32Eaf908C246d3859"
    call = {
        "_asset": chain.usdc,
        "_recipient": executor,
        "_withdrawnValue": 1_000_000_000,
        "_nullifierHashes": [111],
    }

    with pytest.raises(ValueError, match="nullifiers do not match"):
        _validate_withdraw_call(
            call,
            chain=chain,
            executor=executor,
            proof_amount=1_000_000_000,
            zkp_data={"nullifierHashes": [222]},
        )


def test_prejournaled_transaction_is_reconciled_without_rebroadcast():
    class Eth:
        def get_transaction_receipt(self, tx_hash):
            assert tx_hash == "0xabc"
            return SimpleNamespace(status=1)

        def send_raw_transaction(self, _raw):
            raise AssertionError("a confirmed journaled transaction must not be rebroadcast")

    receipt = _confirm_prepared_action(
        SimpleNamespace(eth=Eth()),
        {
            "action": "swap",
            "tx_hash": "0xabc",
            "raw_transaction": "0x01",
        },
    )

    assert receipt.status == 1


def test_recovery_signing_uses_gas_floor_and_waits_for_unwrap_balance(monkeypatch):
    w3 = Mock()
    w3.eth.chain_id = 8453
    w3.eth.get_transaction_count.return_value = 7
    w3.eth.estimate_gas.side_effect = ValueError("stale RPC balance")
    w3.eth.get_balance.side_effect = [1_500_100, 1_501_100]
    w3.keccak.return_value = bytes.fromhex("ab")
    account = SimpleNamespace(
        address="0x0000000000000000000000000000000000000004",
        sign_transaction=Mock(
            return_value=SimpleNamespace(rawTransaction=b"signed")
        ),
    )
    monkeypatch.setattr(
        recovery,
        "fee_params",
        lambda *_args: {"maxPriorityFeePerGas": 1, "maxFeePerGas": 1},
    )
    sleep = Mock()
    monkeypatch.setattr(transaction_policy.time, "sleep", sleep)

    prepared = recovery._prepare_signed_action(
        w3,
        account,
        {
            "to": "0x0000000000000000000000000000000000000001",
            "value": 1_000,
            "gas": 1_500_000,
        },
        "deposit",
    )

    assert prepared["action"] == "deposit"
    assert w3.eth.get_balance.call_count == 2
    sleep.assert_called_once()
    signed_tx = account.sign_transaction.call_args.args[0]
    assert signed_tx["gas"] == 1_500_000


def test_recovery_swap_uses_shared_safe_gas_floor(monkeypatch):
    import evm_executor as evm

    monkeypatch.setattr(evm, "_router_uses_simple_pool_swap", lambda *_args: False)
    monkeypatch.setattr(evm, "_router_uses_classic_v3", lambda *_args: False)
    monkeypatch.setattr(evm, "_router_uses_swap_router_02", lambda *_args: True)
    call = Mock()
    call.build_transaction.side_effect = lambda params: dict(params)
    router = Mock()
    router.functions.exactInputSingle.return_value = call
    w3 = Mock()
    w3.eth.contract.return_value = router
    account = SimpleNamespace(address="0x0000000000000000000000000000000000000004")
    plan = recovery.RecoveryPlan(
        strategy_id="strategy-1",
        chain_id=8453,
        executor=account.address,
        withdraw_tx="0xwithdraw",
        usdc="0x0000000000000000000000000000000000000002",
        weth="0x0000000000000000000000000000000000000003",
        router="0x0000000000000000000000000000000000000006",
        pool="0x0000000000000000000000000000000000000008",
        pool_fee=500,
        output_precommitment="12345",
        slippage_bps=300,
        eth_usd_price=1800.0,
        amount_out_minimum=500,
        amounts=RecoveryAmounts(
            proof_amount=1_000,
            receipt_payout=997,
            vault_fee=3,
            execution_fee=2,
            swap_amount=995,
        ),
    )

    tx = recovery._build_swap_transaction(w3, account, SimpleNamespace(), plan)

    assert tx["gas"] == recovery.SWAP_GAS_FLOOR


def test_failed_recovery_revoke_is_prejournaled_before_broadcast(monkeypatch):
    built_tx = {"to": "0xrouter", "gas": 120_000}
    approve_call = SimpleNamespace(build_transaction=lambda tx: built_tx)
    token = SimpleNamespace(
        functions=SimpleNamespace(
            allowance=lambda owner, router: SimpleNamespace(call=lambda: 123),
            approve=lambda router, amount: approve_call,
        )
    )
    prepared = []

    def prepare(path, journal, w3, account, tx, action):
        prepared.append((path, tx, action))
        return {**journal, "pending_action": {"action": action}}

    monkeypatch.setattr(recovery, "_prepare_pending_action", prepare)
    monkeypatch.setattr(
        recovery,
        "_reconcile_pending_action",
        lambda path, journal, w3, plan: {**journal, "stage": "planned"},
    )

    result = _revoke_router_allowance(
        journal_path="/tmp/recovery.json",
        journal={"stage": "approved"},
        w3=SimpleNamespace(),
        account=SimpleNamespace(),
        token=token,
        plan=SimpleNamespace(executor="0xexecutor", router="0xrouter"),
    )

    assert prepared == [("/tmp/recovery.json", built_tx, "approve_reset")]
    assert result["stage"] == "planned"


def test_forced_sepolia_recovery_keeps_three_percent_pool_slippage_bound():
    assert _pool_relative_minimum(44_927_855_118_107_987, 300) == 43_580_019_464_564_747


def test_pool_price_override_is_impossible_on_base():
    with pytest.raises(ValueError, match="Sepolia-only"):
        _force_pool_price_allowed(
            chain_id=8453,
            strategy_id="strategy-1",
            authorized_strategy_id="strategy-1",
        )

    assert _force_pool_price_allowed(
        chain_id=11155111,
        strategy_id="strategy-1",
        authorized_strategy_id="strategy-1",
    ) is True


def test_pool_price_override_is_bound_to_the_named_recovery():
    with pytest.raises(ValueError, match="does not match"):
        _force_pool_price_allowed(
            chain_id=11155111,
            strategy_id="strategy-1",
            authorized_strategy_id="strategy-2",
        )

    assert _force_pool_price_allowed(
        chain_id=8453,
        strategy_id="strategy-1",
        authorized_strategy_id=None,
    ) is False


def test_forced_pool_quote_metadata_does_not_change_custody_plan_identity():
    base = {
        "strategy_id": "strategy-1",
        "chain_id": 11155111,
        "amount_out_minimum": 500,
        "eth_usd_price": 1800.0,
    }
    forced = {
        **base,
        "amount_out_minimum": 43,
        "oracle_amount_out_minimum": 500,
        "forced_sepolia_pool_price": True,
        "pool_quote": 45,
    }

    assert _plan_identity(base) == _plan_identity(forced)
