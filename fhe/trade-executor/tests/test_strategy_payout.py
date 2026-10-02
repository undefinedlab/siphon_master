"""Strategy payouts (output_mode='bridge'): a fired leg withdraws to the executor, which bridges it.

The money rules under test, beyond the /bridgeWithdraw ones:
  - the order is funded by what THIS spend paid the executor, measured from the receipt — for an
    ETH note that is native ETH, which leaves no Transfer log;
  - a fired payout with no route waits armed instead of proving, spending or burning attempts;
  - a leg that does not pay this executor never gets an order, and a broadcast spend is never
    proved twice.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from test_bridge_payout import (  # noqa: F401  (fixtures)
    A, ctx, chain, _quote, _row, _run, EXEC, USDC, USER, SOL_ADDR, DIAMOND,
)

import bridge_payout as bp

KERNEL = "0x" + "ce" * 20
WETH = "0x4200000000000000000000000000000000000006"
UNSHIELDED = bp._event_topic("AssetsUnshielded(address,uint256,uint256)")
FELL_BACK = bp._event_topic("NativePayoutFellBackToWeth(address,uint256)")


def _pad(x: str | int) -> str:
    return "0x" + (x.lower()[2:] if isinstance(x, str) else f"{x:x}").rjust(64, "0")


def _unshielded(amount, token=WETH, action=0, emitter=KERNEL):
    return {"address": emitter, "topics": ["0x" + UNSHIELDED, _pad(token), _pad(action)],
            "data": hex(amount)}


@pytest.fixture
def cfg(monkeypatch):
    import evm_chain_config

    stub = SimpleNamespace(chain_id=8453, vault_kernel=KERNEL, weth=WETH, usdc=USDC)
    monkeypatch.setattr(evm_chain_config, "get_evm_chain_config", lambda cid: stub)
    return stub


# ── measuring a native payout ───────────────────────────────────────────────────────────────────

def test_native_payout_is_the_kernels_unshielded_amount(cfg):
    receipt = {"status": 1, "logs": [
        _unshielded(10**15),
        _unshielded(7, emitter="0x" + "ab" * 20),   # not the kernel
        _unshielded(9, token=USDC),                  # a USDC withdraw is not native ETH
        _unshielded(11, action=4),                   # a ragequit is not this order's withdraw
        {"address": KERNEL, "topics": [], "data": "0x"},
    ]}
    assert bp.payout_received(receipt, bp.NATIVE, EXEC, 8453) == 10**15


def test_a_weth_fallback_to_the_executor_counts_as_nothing_received(cfg):
    receipt = {"status": 1, "logs": [
        _unshielded(10**15),
        {"address": KERNEL, "topics": ["0x" + FELL_BACK, _pad(EXEC)], "data": hex(10**15)},
    ]}
    assert bp.payout_received(receipt, bp.NATIVE, EXEC, 8453) == 0


# ── quoting from native ETH ─────────────────────────────────────────────────────────────────────

NATIVE_QC = dict(chain_id=8453, amount=10**15, min_out=1, order={"to_chain_id": 1, "to_address": USER},
                 from_address=EXEC, from_token=bp.NATIVE)


def _native_quote(value=10**15):
    return _quote(transactionRequest__value=hex(value), estimate__fromAmount=str(10**15),
                  action__fromToken={"address": bp.NATIVE})


def test_a_native_route_may_carry_exactly_its_own_amount():
    assert bp.check_quote(_native_quote(), **NATIVE_QC) is None
    assert "native value" in bp.check_quote(_native_quote(10**15 + 1), **NATIVE_QC)


def test_a_usdc_route_still_may_not_carry_value():
    q = _quote(transactionRequest__value="0x1")
    assert "native value" in bp.check_quote(q, chain_id=8453, amount=5_000_000, min_out=1,
                                            order={"to_chain_id": 1, "to_address": USER},
                                            from_address=EXEC, from_token=USDC)


def test_native_order_bridges_its_amount_as_value_with_no_approval(ctx, chain, monkeypatch):
    monkeypatch.setattr(bp, "get_quote", lambda *a, **k: _native_quote())
    o = _run(_row(ctx, token=bp.NATIVE, amount_in=str(10**15), min_out="1"))
    assert o.status == "SENT"
    [(label, tx)] = chain.sent
    assert label == "lifi_bridge" and tx["value"] == 10**15 and tx["to"] == DIAMOND


def test_native_refund_returns_eth(ctx, chain):
    o = _run(_row(ctx, token=bp.NATIVE, amount_in=str(10**15), status="REFUND_DUE"))
    assert o.status == "REFUNDED" and o.refund_tx
    [(label, tx)] = chain.sent
    assert label == "bridge_refund" and tx["value"] == 10**15 and tx["to"] == USER


# ── the fire-time floor and payout validation ───────────────────────────────────────────────────

def test_fire_floor_prices_stables_at_a_dollar_and_others_by_lifi():
    keep = 1 - (100 + bp.FIRE_FEE_ALLOWANCE_BPS) / 10_000
    usdc = {"action": {"toToken": {"symbol": "USDC", "decimals": 6, "priceUSD": "0.5"}}}
    assert bp.fire_min_out(usdc, 2.0, 100) == int(2.0 * keep * 10**6)
    zec = {"action": {"toToken": {"symbol": "ZEC", "decimals": 8, "priceUSD": "40"}}}
    assert bp.fire_min_out(zec, 20.0, 100) == int(20.0 * keep / 40 * 10**8)
    with pytest.raises(ValueError):
        bp.fire_min_out({"action": {"toToken": {"symbol": "ZEC", "decimals": 8}}}, 20.0, 100)


def test_parse_payout():
    good = {"to_chain_id": bp.SOLANA_LIFI_ID, "to_address": SOL_ADDR, "refund_address": USER}
    assert bp.parse_payout(good, 8453)["slippage_bps"] == 100
    for bad in ({**good, "slippage_bps": 0}, {**good, "slippage_bps": 5000},
                {**good, "to_chain_id": 8453, "to_address": USER},   # the source chain
                {**good, "to_address": USER}):                       # EVM address on Solana
        with pytest.raises(ValueError):
            bp.parse_payout(bad, 8453)
    with pytest.raises(ValueError):
        bp.source_token(8453, "WBTC")


# ── firing a payout leg ─────────────────────────────────────────────────────────────────────────

import decryptor_client  # noqa: E402
import executor_runner  # noqa: E402

PAYOUT = {"to_chain_id": bp.SOLANA_LIFI_ID, "to_address": SOL_ADDR, "to_token": "USDC",
          "refund_address": USER, "slippage_bps": 100}
STRAT = {"id": "s-pay", "chain_id": 8453, "user_id": USER, "asset_in": "ETH", "amount": 0.001,
         "output_mode": "bridge", "payout": PAYOUT}
LEG = {"id": "s-pay", "leg_index": 0, "commitment_id": None}
AMOUNT = 10**15


def _signals(payee_asset=WETH, action=0, amount=AMOUNT):
    pi = [0] * 25
    pi[0], pi[1], pi[5], pi[9], pi[16], pi[17] = action, 1, amount, 111, 5, int(payee_asset, 16)
    return [str(x) for x in pi]


def _proved(payee=EXEC, **kw):
    return {"proof": [str(i) for i in range(8)], "publicSignals": _signals(**kw),
            "complianceProof": [str(i) for i in range(8)], "compliancePublicSignals": ["1", "0", "0", "0", "5"],
            "rawPayee": payee[2:].lower(), "attestationExpiry": 9_999_999_999, "attesterSig": "ab" * 65}


@pytest.fixture
def fire(ctx, cfg, monkeypatch):
    import evm_executor

    w3 = SimpleNamespace(receipts={})
    w3.eth = SimpleNamespace(get_transaction_receipt=lambda h: w3.receipts[h])
    calls = {"proved": 0, "submitted": [], "released": [], "spent": []}
    monkeypatch.setattr(evm_executor, "get_web3", lambda c: w3)
    monkeypatch.setattr(evm_executor, "get_executor_account", lambda w, cid: SimpleNamespace(address=EXEC))
    monkeypatch.setattr(executor_runner, "_claim_nullifiers", lambda h, c: True)
    monkeypatch.setattr(executor_runner, "_release_nullifiers", lambda h: calls["released"].append(h))
    monkeypatch.setattr(executor_runner, "_mark_nullifiers_spent", lambda h: calls["spent"].append(h))
    q = {"action": {"toToken": {"symbol": "USDC", "decimals": 6}}}
    monkeypatch.setattr(bp, "fire_check", lambda *a, **k: {"token": bp.NATIVE, "decimals": 18,
                                                           "price": 2000.0, "quote": q})

    def prove(sid, i, result=None):
        calls["proved"] += 1
        return (calls.get("result") or _proved()), None

    monkeypatch.setattr(decryptor_client, "prove_spend_leg", prove)

    def submit(w3_, account, chain_, on_prepared=None, **kw):
        h = "0x" + "aa" * 32
        on_prepared(h, "raw")
        calls["submitted"].append(kw)
        w3.receipts[h] = {"status": 1, "logs": [_unshielded(AMOUNT)]}
        return h

    monkeypatch.setattr(evm_executor, "vault_kernel_spend_attested", submit)
    return calls


def _orders():
    from database import BridgeOrder
    return BridgeOrder.query.filter_by(strategy_id="s-pay").all()


def test_a_fired_payout_funds_an_order_from_its_receipt(fire):
    out = executor_runner._execute_attested_leg(LEG, STRAT)
    assert out["status"] == "EXECUTED"
    [o] = _orders()
    assert (o.status, o.token, o.amount_in, o.spend_tx) == ("RECEIVED", bp.NATIVE, str(AMOUNT), "0x" + "aa" * 32)
    assert (o.to_chain_id, o.to_address, o.refund_address) == (str(bp.SOLANA_LIFI_ID), SOL_ADDR, USER)
    keep = 1 - (100 + bp.FIRE_FEE_ALLOWANCE_BPS) / 10_000
    assert int(o.min_out) == int(0.001 * 2000 * keep * 10**6)  # $2 of ETH, less slippage and fees
    assert fire["spent"] == [["111"]]


def test_no_route_waits_without_proving(fire, monkeypatch):
    monkeypatch.setattr(bp, "fire_check", lambda *a, **k: (_ for _ in ()).throw(ValueError("no route")))
    assert executor_runner._execute_attested_leg(LEG, STRAT)["status"] == "WAIT"
    assert fire["proved"] == 0 and not _orders()


@pytest.mark.parametrize("result", [
    _proved(payee=USER),                 # pays someone else
    _proved(payee_asset=USDC),           # withdraws USDC while the order expects native ETH
    _proved(action=2),                   # a swap, not a withdraw
])
def test_a_leg_that_does_not_pay_this_executor_gets_no_order(fire, result):
    fire["result"] = result
    assert executor_runner._execute_attested_leg(LEG, STRAT)["status"] == "FAILED"
    assert not fire["submitted"] and not _orders() and fire["released"] == [["111"]]


def test_a_broadcast_spend_is_never_proved_again(fire, ctx):
    _row(ctx, strategy_id="s-pay", status="RELAYING", spend_tx="0x" + "bb" * 32, amount_in=None)
    assert executor_runner._execute_attested_leg(LEG, STRAT)["status"] == "WAIT"
    from database import BridgeOrder
    o = BridgeOrder.query.filter_by(strategy_id="s-pay").first()
    o.status = "RECEIVED"
    ctx.db.session.commit()
    assert executor_runner._execute_attested_leg(LEG, STRAT) == {"status": "EXECUTED", "tx_hash": "0x" + "bb" * 32}
    assert fire["proved"] == 0


def test_a_failed_submission_before_broadcast_leaves_no_order(fire, monkeypatch):
    import evm_executor

    def boom(*a, **k):
        raise RuntimeError("nonce too low")

    monkeypatch.setattr(evm_executor, "vault_kernel_spend_attested", boom)
    assert executor_runner._execute_attested_leg(LEG, STRAT)["status"] == "RETRY"
    assert not _orders() and fire["released"] == [["111"]]


def test_a_tempo_payout_names_usdc_e_by_address_and_must_be_paid_there():
    """The Tempo home's "Withdraw to Tempo" sends USDC.e by address (hub.ts BRIDGE_DESTS)."""
    usdc_e = "0x20C000000000000000000000b9537d11c60E8b50"
    payout = bp.parse_payout({"to_chain_id": 4217, "to_address": USER, "to_token": usdc_e,
                              "refund_address": USER}, 8453)
    assert (payout["to_chain_id"], payout["to_token"], payout["slippage_bps"]) == (4217, usdc_e, 100)
    q = _quote(action__toChainId=4217, estimate__toAmountMin="4950000")
    assert bp.check_quote(q, chain_id=8453, amount=5_000_000, min_out=4_900_000, order=payout,
                          from_address=EXEC, from_token=USDC) is None
    q = _quote(action__toChainId=4217, action__toAddress=EXEC)
    assert "destination" in bp.check_quote(q, chain_id=8453, amount=5_000_000, min_out=1, order=payout,
                                           from_address=EXEC, from_token=USDC)
