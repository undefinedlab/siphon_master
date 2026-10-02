from types import SimpleNamespace
from unittest.mock import Mock

import fee_calc
import pytest
import transaction_policy

import evm_executor as evm


def _install_trade_fakes(monkeypatch):
    w3 = Mock()
    w3.is_connected.return_value = True
    w3.eth.chain_id = 11155111
    chain = SimpleNamespace(
        chain_id=11155111,
        name="Ethereum Sepolia",
        entrypoint="0x0000000000000000000000000000000000000001",
        rpc_url="http://rpc.invalid",
        usdc="0x0000000000000000000000000000000000000002",
        weth="0x0000000000000000000000000000000000000003",
        uniswap_v3_router="0x0000000000000000000000000000000000000006",
        uniswap_v3_factory="0x0000000000000000000000000000000000000007",
        swap_fee_tier=3000,
        token_address=lambda symbol: {
            "USDC": "0x0000000000000000000000000000000000000002",
            "ETH": evm.NATIVE_ASSET,
        }[symbol],
    )
    account = SimpleNamespace(address="0x0000000000000000000000000000000000000004")

    monkeypatch.setattr(evm, "evm_remote_signing", lambda: True)
    monkeypatch.setattr(evm, "get_evm_chain_config", lambda _chain_id: chain)
    monkeypatch.setattr(evm, "get_web3", lambda _chain: w3)
    monkeypatch.setattr(evm, "get_executor_account", lambda _w3, _chain_id: account)
    monkeypatch.setattr(
        evm,
        "_resolve_v3_pool",
        lambda *_args: ("0x0000000000000000000000000000000000000008", 3000),
    )
    monkeypatch.setattr(evm, "_router_uses_simple_swap", lambda *_args: True)
    monkeypatch.setattr(evm, "_router_uses_simple_pool_swap", lambda *_args: False)
    monkeypatch.setattr(evm, "_router_uses_classic_v3", lambda *_args: True)
    monkeypatch.setattr(evm, "_router_uses_swap_router_02", lambda *_args: False)
    monkeypatch.setattr(
        fee_calc,
        "compute_execution_fee_wei",
        lambda *_args, **_kwargs: 2_000_053,
    )
    return w3, chain, account


def test_single_shot_usdc_to_eth_redeposits_only_the_net_swap_output(monkeypatch):
    w3, chain, account = _install_trade_fakes(monkeypatch)
    swap = Mock(return_value=("0xswap", 531_000_000_000_000_000))
    deposit = Mock(return_value="0xdeposit")
    monkeypatch.setattr(evm, "swap_token_to_eth", swap, raising=False)
    monkeypatch.setattr(evm, "deposit_native_to_vault", deposit)
    withdraw = Mock(return_value="0xwithdraw")
    monkeypatch.setattr(evm, "zk_withdraw_from_vault", withdraw)

    result = evm.execute_evm_trade(
        {
            "id": "strategy-1",
            "asset_in": "USDC",
            "asset_out": "ETH",
            "amount": 1000,
            "recipient_address": "0x0000000000000000000000000000000000000005",
            "from_chain": "11155111",
            "to_chain": "11155111",
            "output_mode": "vault",
            "output_precommitment": "12345",
            "max_slippage_bps": 300,
            "is_private": True,
            "zkp_data": {"pA": [1, 2], "stateRoot": "1"},
        },
        current_price=1877.35,
    )

    assert result == "0xdeposit"
    swap.assert_called_once_with(
        w3,
        account,
        chain,
        chain.usdc,
        997_999_947,
        515_652_354_963_112_897,
    )
    deposit.assert_called_once_with(
        w3,
        account,
        chain,
        531_000_000_000_000_000,
        12345,
    )


def test_single_shot_usdc_to_eth_can_deliver_native_output_to_address(monkeypatch):
    w3, chain, account = _install_trade_fakes(monkeypatch)
    swap = Mock(return_value=("0xunwrap", 531_000_000_000_000_000))
    transfer = Mock(return_value="0xtransfer")
    monkeypatch.setattr(evm, "swap_token_to_eth", swap)
    monkeypatch.setattr(evm, "transfer_eth", transfer)

    recipient = "0x0000000000000000000000000000000000000005"
    result = evm.execute_evm_trade(
        {
            "id": "strategy-2",
            "asset_in": "USDC",
            "asset_out": "ETH",
            "amount": 1000,
            "recipient_address": recipient,
            "from_chain": "11155111",
            "to_chain": "11155111",
            "output_mode": "address",
            "max_slippage_bps": 300,
            "is_private": False,
        },
        current_price=1877.35,
    )

    assert result == "0xtransfer"
    transfer.assert_called_once_with(
        w3, account, recipient, 531_000_000_000_000_000
    )


def test_native_vault_delivery_uses_base_safe_gas_floor(monkeypatch):
    w3 = Mock()
    account = SimpleNamespace(
        address="0x0000000000000000000000000000000000000004"
    )
    chain = SimpleNamespace(
        entrypoint="0x0000000000000000000000000000000000000001"
    )
    entrypoint = Mock()
    entrypoint.functions.deposit.return_value.build_transaction.side_effect = (
        lambda params: {**params, "to": chain.entrypoint, "data": b"deposit"}
    )
    w3.eth.contract.return_value = entrypoint
    send = Mock(return_value="0xdeposit")
    monkeypatch.setattr(evm, "send_tx", send)

    result = evm.deposit_native_to_vault(w3, account, chain, 13_403, 12345)

    assert result == "0xdeposit"
    sent_tx = send.call_args.args[2]
    assert sent_tx["value"] == 13_403
    assert sent_tx["gas"] >= 1_500_000
    assert send.call_args.kwargs["label"] == "vault_deposit_native"


def test_all_proof_and_vault_fallbacks_cover_observed_base_gas():
    assert evm._GAS_FALLBACK["zk_withdraw"] >= 1_500_000
    assert evm._GAS_FALLBACK["vault_deposit"] >= 1_500_000
    assert evm._GAS_FALLBACK["vault_deposit_native"] >= 1_500_000


def test_value_transaction_waits_for_rpc_balance_before_broadcast(monkeypatch):
    class TxHash:
        def hex(self):
            return "0xabc"

    w3 = Mock()
    w3.eth.chain_id = 8453
    w3.eth.get_transaction_count.return_value = 7
    w3.eth.estimate_gas.side_effect = ValueError("stale RPC balance")
    # First replica has not observed the unwrap; the second one has.
    w3.eth.get_balance.side_effect = [1_500_100, 1_501_100]
    w3.eth.send_raw_transaction.return_value = TxHash()
    w3.eth.wait_for_transaction_receipt.return_value = SimpleNamespace(
        status=1,
        blockNumber=123,
        gasUsed=971_506,
    )
    account = SimpleNamespace(
        address="0x0000000000000000000000000000000000000004",
        sign_transaction=Mock(
            return_value=SimpleNamespace(rawTransaction=b"signed")
        ),
    )
    monkeypatch.setattr(
        evm,
        "fee_params",
        lambda *_args: {"maxPriorityFeePerGas": 1, "maxFeePerGas": 1},
    )
    sleep = Mock()
    monkeypatch.setattr(transaction_policy.time, "sleep", sleep)

    result = evm.send_tx(
        w3,
        account,
        {
            "to": "0x0000000000000000000000000000000000000001",
            "value": 1_000,
            "gas": 1_500_000,
        },
        label="vault_deposit_native",
    )

    assert result == "0xabc"
    assert w3.eth.get_balance.call_count == 2
    sleep.assert_called_once()
    account.sign_transaction.assert_called_once()


def test_inflight_retry_rebroadcasts_identical_prepared_bytes(monkeypatch):
    class TxHash:
        def hex(self):
            return "0xabc"

    w3 = Mock()
    w3.eth.chain_id = 8453
    w3.eth.get_transaction_count.return_value = 7
    w3.eth.estimate_gas.return_value = 100_000
    w3.eth.get_balance.return_value = 10**18
    w3.eth.send_raw_transaction.side_effect = [
        ValueError("in-flight transaction limit reached for delegated accounts"),
        TxHash(),
    ]
    w3.eth.wait_for_transaction_receipt.return_value = SimpleNamespace(
        status=1, blockNumber=123, gasUsed=90_000
    )
    w3.keccak.return_value = SimpleNamespace(hex=lambda: "0xprepared")
    account = SimpleNamespace(
        address="0x0000000000000000000000000000000000000004",
        sign_transaction=Mock(return_value=SimpleNamespace(rawTransaction=b"immutable")),
    )
    monkeypatch.setattr(
        evm,
        "fee_params",
        lambda *_args: {"maxPriorityFeePerGas": 1, "maxFeePerGas": 1},
    )
    monkeypatch.setattr(evm.time, "sleep", lambda *_: None)
    prepared = Mock()

    assert evm.send_tx(
        w3,
        account,
        {"to": "0x0000000000000000000000000000000000000001"},
        on_prepared=prepared,
    ) == "0xabc"
    account.sign_transaction.assert_called_once()
    prepared.assert_called_once_with("0xprepared", b"immutable".hex())
    assert w3.eth.send_raw_transaction.call_args_list == [
        ((b"immutable",),),
        ((b"immutable",),),
    ]


def test_prepared_transaction_hash_is_checked_before_recovery_broadcast():
    w3 = Mock()
    w3.keccak.return_value = SimpleNamespace(hex=lambda: "0xactual")

    with pytest.raises(ValueError, match="hash mismatch"):
        evm.verified_prepared_transaction("0102", "0xexpected", w3)

    w3.keccak.return_value = SimpleNamespace(hex=lambda: "0xexpected")
    assert evm.verified_prepared_transaction("0x0102", "0xexpected", w3) == b"\x01\x02"


def test_single_shot_eth_to_usdc_passes_a_nonzero_oracle_minimum(monkeypatch):
    w3, chain, account = _install_trade_fakes(monkeypatch)
    swap = Mock(return_value="0xswap")
    monkeypatch.setattr(evm, "swap_eth_to_token", swap)
    monkeypatch.setattr(fee_calc, "compute_execution_fee_wei", lambda *_args: 0)

    result = evm.execute_evm_trade(
        {
            "id": "strategy-3",
            "asset_in": "ETH",
            "asset_out": "USDC",
            "amount": 1,
            "recipient_address": "0x0000000000000000000000000000000000000005",
            "from_chain": "11155111",
            "to_chain": "11155111",
            "output_mode": "address",
            "max_slippage_bps": 300,
            "is_private": False,
        },
        current_price=1877.35,
    )

    assert result == "0xswap"
    assert swap.call_args.args[-1] == 1_821_029_500


def test_vault_output_never_falls_back_to_the_executor_pooled_token_balance(monkeypatch):
    _install_trade_fakes(monkeypatch)
    monkeypatch.setattr(fee_calc, "compute_execution_fee_wei", lambda *_args: 0)
    monkeypatch.setattr(evm, "swap_eth_to_token", lambda *_args: "0xswap")
    monkeypatch.setattr(evm, "token_received_in_tx", lambda *_args: 0)
    monkeypatch.setattr(evm, "erc20_balance_of", lambda *_args: 9_999_999_999)
    deposit = Mock(return_value="0xdeposit")
    monkeypatch.setattr(evm, "deposit_to_vault", deposit)

    result = evm.execute_evm_trade(
        {
            "id": "strategy-4",
            "asset_in": "ETH",
            "asset_out": "USDC",
            "amount": 1,
            "recipient_address": "0x0000000000000000000000000000000000000005",
            "from_chain": "11155111",
            "to_chain": "11155111",
            "output_mode": "vault",
            "output_precommitment": "12345",
            "max_slippage_bps": 300,
            "is_private": False,
        },
        current_price=1877.35,
    )

    assert result is None
    deposit.assert_not_called()


def test_missing_slippage_uses_protected_default_not_zero():
    assert evm.minimum_output_wei(
        "USDC", "ETH", 997_999_947, 1877.35, None
    ) == 515_652_354_963_112_897


def test_private_trade_without_zk_proof_cannot_spend_pooled_funds(monkeypatch):
    _install_trade_fakes(monkeypatch)
    swap = Mock()
    monkeypatch.setattr(evm, "swap_token_to_eth", swap)

    with pytest.raises(evm.FatalExecutionError, match="requires a ZK withdrawal proof"):
        evm.execute_evm_trade(
            {
                "id": "strategy-private-missing-proof",
                "asset_in": "USDC",
                "asset_out": "ETH",
                "amount": 1000,
                "recipient_address": "0x0000000000000000000000000000000000000005",
                "from_chain": "11155111",
                "to_chain": "11155111",
                "output_mode": "vault",
                "output_precommitment": "12345",
                "max_slippage_bps": 300,
                "is_private": True,
            },
            current_price=1877.35,
        )

    swap.assert_not_called()


def test_invalid_slippage_is_rejected_before_private_withdrawal(monkeypatch):
    _install_trade_fakes(monkeypatch)
    withdraw = Mock(return_value="0xwithdraw")
    monkeypatch.setattr(evm, "zk_withdraw_from_vault", withdraw)

    result = evm.execute_evm_trade(
        {
            "id": "strategy-invalid-slippage",
            "asset_in": "USDC",
            "asset_out": "ETH",
            "amount": 1000,
            "recipient_address": "0x0000000000000000000000000000000000000005",
            "from_chain": "11155111",
            "to_chain": "11155111",
            "output_mode": "vault",
            "output_precommitment": "12345",
            "max_slippage_bps": 5001,
            "is_private": True,
            "zkp_data": {"pA": [1, 2], "stateRoot": "1"},
        },
        current_price=1877.35,
    )

    assert result is None
    withdraw.assert_not_called()


def test_zero_slippage_is_rejected_before_private_withdrawal(monkeypatch):
    _install_trade_fakes(monkeypatch)
    withdraw = Mock(return_value="0xwithdraw")
    monkeypatch.setattr(evm, "zk_withdraw_from_vault", withdraw)

    result = evm.execute_evm_trade(
        {
            "id": "strategy-zero-slippage",
            "asset_in": "USDC",
            "asset_out": "ETH",
            "amount": 1000,
            "recipient_address": "0x0000000000000000000000000000000000000005",
            "from_chain": "11155111",
            "to_chain": "11155111",
            "output_mode": "vault",
            "output_precommitment": "12345",
            "max_slippage_bps": 0,
            "is_private": True,
            "zkp_data": {"pA": [1, 2], "stateRoot": "1"},
        },
        current_price=1877.35,
    )

    assert result is None
    withdraw.assert_not_called()


def _install_router_fakes(monkeypatch, deployed_selector):
    token_address = "0x0000000000000000000000000000000000000002"
    weth_address = "0x0000000000000000000000000000000000000003"
    router_address = "0x0000000000000000000000000000000000000006"
    account = SimpleNamespace(address="0x0000000000000000000000000000000000000004")
    chain = SimpleNamespace(
        chain_id=11155111,
        name="Ethereum Sepolia",
        uniswap_v3_router=router_address,
        uniswap_v3_factory="0x0000000000000000000000000000000000000007",
        weth=weth_address,
        swap_fee_tier=3000,
    )
    w3 = Mock()
    w3.eth.get_code.return_value = bytes.fromhex(deployed_selector)

    token = Mock()
    router = Mock()
    weth = Mock()
    router.functions.exactInputSingle.return_value.build_transaction.return_value = {
        "to": router_address
    }
    router.functions.exactInputSingleWithPool.return_value.build_transaction.return_value = {
        "to": router_address
    }
    weth.functions.withdraw.return_value.build_transaction.return_value = {
        "to": weth_address
    }

    def contract(*, address, abi):
        if address.lower() == token_address.lower():
            return token
        if address.lower() == weth_address.lower():
            return weth
        if address.lower() == router_address.lower():
            return router
        raise AssertionError(f"unexpected contract {address}")

    w3.eth.contract.side_effect = contract
    monkeypatch.setattr(
        evm,
        "_resolve_v3_pool",
        lambda *_args: ("0x0000000000000000000000000000000000000008", 3000),
    )
    approve = Mock()
    monkeypatch.setattr(evm, "_approve_erc20_exact", approve)
    monkeypatch.setattr(evm, "token_received_in_tx", lambda *_args: 531)
    send = Mock(side_effect=["0xswap", "0xunwrap"])
    monkeypatch.setattr(evm, "send_tx", send)
    return w3, chain, account, router, weth, approve


def test_token_to_eth_uses_classic_v3_router_on_sepolia(monkeypatch):
    w3, chain, account, router, weth, approve = _install_router_fakes(
        monkeypatch, evm._SWAP_ROUTER_V3_SELECTOR
    )

    result = evm.swap_token_to_eth(
        w3, account, chain,
        "0x0000000000000000000000000000000000000002",
        997,
        515,
    )

    assert result == ("0xunwrap", 531)
    params = router.functions.exactInputSingle.call_args.args[0]
    assert len(params) == 8
    assert params[5] == 997
    assert params[6] == 515
    weth.functions.withdraw.assert_called_once_with(531)
    approve.assert_called_once()


def test_token_to_eth_uses_explicit_pool_router_on_sepolia(monkeypatch):
    w3, chain, account, router, weth, approve = _install_router_fakes(
        monkeypatch, evm._SIMPLE_POOL_SWAP_SELECTOR
    )

    result = evm.swap_token_to_eth(
        w3,
        account,
        chain,
        "0x0000000000000000000000000000000000000002",
        997,
        515,
    )

    assert result == ("0xunwrap", 531)
    pool, params = router.functions.exactInputSingleWithPool.call_args.args
    assert pool == "0x0000000000000000000000000000000000000008"
    assert len(params) == 8
    assert params[5] == 997
    assert params[6] == 515
    weth.functions.withdraw.assert_called_once_with(531)
    approve.assert_called_once()


def test_token_to_eth_uses_swap_router_02_on_base(monkeypatch):
    w3, chain, account, router, weth, _ = _install_router_fakes(
        monkeypatch, evm._SWAP_ROUTER_02_SELECTOR
    )
    chain.chain_id = 8453
    chain.name = "Base"

    result = evm.swap_token_to_eth(
        w3, account, chain,
        "0x0000000000000000000000000000000000000002",
        997,
        515,
    )

    assert result == ("0xunwrap", 531)
    params = router.functions.exactInputSingle.call_args.args[0]
    assert len(params) == 7
    assert params[4] == 997
    assert params[5] == 515
    weth.functions.withdraw.assert_called_once_with(531)
