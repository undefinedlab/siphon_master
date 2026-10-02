"""Private perps on Hyperliquid: create-time validation and the position state machine.

Every user's margin sits in ONE executor account, so the money rules under test are:
  - margin is what this strategy's bridge order delivered, and the funding destination is built
    server-side (a client cannot point a perp's margin anywhere else);
  - an exit is an opposite IOC of exactly this position's size — never the account's net position;
  - payout = margin + PnL − fees − funding, from this position's own fills, never below zero;
  - a restart finds a sent order again by its cloid instead of sending a second one, and a payout
    whose outcome is unknown goes to REVIEW instead of being sent twice.
"""
from __future__ import annotations

import json
import sys
from types import SimpleNamespace

import pytest
from flask import Flask

from database import BridgeOrder, HyperliquidPosition, Strategy, db
import hyperliquid_client as hl
import hyperliquid_watcher as w

USER = "0x57fBC5C7e1A40134eC3cE2fe06EBD26d9C7267A2"
OTHER = "0x00000000000000000000000000000000000000aa"
ACCOUNT = "0x5830A431E6866B8F8a605625b0713D8190FB06bA"
META = {
    "BTC": {"name": "BTC", "szDecimals": 5, "maxLeverage": 40},
    "ETH": {"name": "ETH", "szDecimals": 4, "maxLeverage": 25},
    "HYPE": {"name": "HYPE", "szDecimals": 2, "maxLeverage": 10, "onlyIsolated": True},
    "OLD": {"name": "OLD", "szDecimals": 0, "maxLeverage": 3, "isDelisted": True},
}


@pytest.fixture(autouse=True)
def markets(monkeypatch):
    monkeypatch.setattr(hl, "market", lambda coin: META.get(coin.upper()))
    monkeypatch.setattr(hl, "account", lambda: ACCOUNT)
    monkeypatch.setenv("HYPERLIQUID_MASTER_PRIVATE_KEY", "0x" + "11" * 32)
    monkeypatch.delenv("HYPERLIQUID_TESTNET", raising=False)


# ── sizing and ids ──────────────────────────────────────────────────────────────────────────────

def test_leverage_cap_is_half_the_coins_max_and_the_global_cap():
    assert hl.leverage_cap("ETH") == 12
    assert hl.leverage_cap("BTC") == 20  # HYPERLIQUID_MAX_LEVERAGE
    assert hl.leverage_cap("NOPE") == 1


def test_size_floors_to_the_coins_step():
    assert hl.round_size("BTC", 0.000129999) == 0.00012
    assert hl.round_size("ETH", 0.00999) == 0.0099
    assert hl.round_size("ETH", 0.00004) == 0


def test_cloids_are_16_bytes_stable_and_distinct_per_attempt():
    a = hl.cloid("pos-1", "open", 0)
    assert a == hl.cloid("pos-1", "open", 0) and len(a) == 34 and a.startswith("0x")
    assert a != hl.cloid("pos-1", "open", 1) != hl.cloid("pos-1", "close", 1)


def test_order_fills_counts_only_this_orders_fills(monkeypatch):
    def info(p):
        if p["type"] == "orderStatus":
            return {"status": "order", "order": {"order": {"oid": 7}, "status": "filled"}}
        return [{"oid": 7, "sz": "1", "px": "100", "fee": "0.05"},
                {"oid": 7, "sz": "3", "px": "104", "fee": "0.15"},
                {"oid": 8, "sz": "9", "px": "1", "fee": "9"}]

    monkeypatch.setattr(hl, "info", info)
    f = hl.order_fills("0x" + "ab" * 16, 0)
    assert (f["status"], f["oid"], f["sz"], f["avg_px"]) == ("filled", 7, 4.0, 103.0)
    assert f["fee"] == pytest.approx(0.2)
    monkeypatch.setattr(hl, "info", lambda p: {"status": "unknownOid"})
    assert hl.order_fills("0x" + "ab" * 16, 0)["status"] == "unknownOid"


def test_funding_longs_pay_positive_rates_shorts_receive(monkeypatch):
    monkeypatch.setattr(hl, "info", lambda p: [{"fundingRate": "0.0001"}, {"fundingRate": "0.0003"}])
    assert hl.funding_usd("ETH", "LONG", 2.0, 1000.0, 0, 1) == pytest.approx(0.8)
    assert hl.funding_usd("ETH", "SHORT", 2.0, 1000.0, 0, 1) == pytest.approx(-0.8)


def test_bridge_errors_are_typed(monkeypatch, tmp_path):
    script = tmp_path / "bridge.py"
    monkeypatch.setattr(hl, "_BRIDGE", script)
    monkeypatch.setenv("HYPERLIQUID_PYTHON", sys.executable)
    script.write_text('print("noise"); print(\'{"oid": 5, "filled_sz": 1.0, "avg_px": 2.0}\')')
    assert hl.place_order("ETH", is_buy=True, size=1.0, order_cloid="0x" + "0" * 32)["oid"] == 5
    script.write_text('import sys; print(\'{"error": "hyperliquid refused: no margin"}\'); sys.exit(1)')
    assert hl.place_order("ETH", is_buy=True, size=1.0, order_cloid="0x" + "0" * 32) == {
        "rejected": "hyperliquid refused: no margin"}
    script.write_text('import sys; print(\'{"error": "HYPERLIQUID_MASTER_PRIVATE_KEY not set"}\'); sys.exit(1)')
    with pytest.raises(hl.HyperliquidNotConfigured):
        hl.send_usd(1.0, USER)
    script.write_text('import sys; print(\'{"error": "hyperliquid refused: insufficient"}\'); sys.exit(1)')
    with pytest.raises(RuntimeError, match="refused"):
        hl.withdraw(5.0, USER)


# ── create-time validation ──────────────────────────────────────────────────────────────────────

def _order(**over):
    m = {"coin": "eth", "side": "long", "leverage": 3, "take_profit_px": "4000", "stop_loss_px": 2000}
    m.update(over)
    return m


def test_validate_normalizes_and_defaults_the_exit_to_the_user_on_hypercore():
    meta = hl.validate_order(_order(), 10.0, USER)
    assert meta == {"coin": "ETH", "side": "LONG", "leverage": 3, "take_profit_px": 4000.0,
                    "stop_loss_px": 2000.0, "trigger_dir": "below",
                    "exit_to": {"to_chain_id": 1337, "to_address": USER}}
    arb = hl.validate_order(_order(exit_to={"to_chain_id": 42161, "to_address": OTHER}), 10.0, USER)
    assert arb["exit_to"] == {"to_chain_id": 42161, "to_address": OTHER}


@pytest.mark.parametrize("over,margin,msg", [
    ({"coin": "NOPE"}, 10, "no perp market"),
    ({"coin": "OLD"}, 10, "no perp market"),
    ({"coin": "HYPE"}, 10, "isolated-only"),
    ({"side": "up"}, 10, "LONG or SHORT"),
    ({"leverage": 13}, 10, "1–12"),
    ({"leverage": 0}, 10, "1–12"),
    ({"leverage": 1}, 10, "at least"),                       # $10 notional < $11
    ({"take_profit_px": 1500}, 10, "beyond stop loss"),        # long TP below SL
    ({"side": "SHORT"}, 10, "beyond stop loss"),               # short TP above SL
    ({"stop_loss_px": -1}, 10, "positive"),
    ({"exit_to": {"to_chain_id": 8453}}, 10, "Hyperliquid"),
    ({"exit_to": {"to_address": "8xueCcQRMhKo5CtppfmxXar2LuVaHfiiN3VzhxepqNEg"}}, 10, "EVM address"),
])
def test_validate_refuses(over, margin, msg):
    with pytest.raises(ValueError, match=msg):
        hl.validate_order(_order(**over), margin, USER)


def _create_body(**over):
    body = {"strategy_type": "HYPERLIQUID", "user_id": USER, "asset_in": "USDC", "asset_out": "ETH",
            "amount": 10, "hl_meta": _order(),
            # A client-supplied payout must never survive: margin goes to the executor's account.
            "payout": {"to_chain_id": 1337, "to_address": OTHER, "refund_address": OTHER,
                       "slippage_bps": 50}}
    body.update(over)
    return body


@pytest.fixture
def attested(monkeypatch):
    import vault_generation
    monkeypatch.setattr(vault_generation, "is_attested_strategy", lambda d: not d.get("zk_proof"))


def test_create_builds_the_funding_payout_server_side(attested):
    body = _create_body()
    assert hl.prepare_strategy(body) is None
    assert body["payout"] == {"to_chain_id": 1337, "to_address": ACCOUNT, "to_token": "USDC",
                              "refund_address": USER, "slippage_bps": 50}
    assert body["output_mode"] == "bridge" and body["price_feed_id"] == "hyperliquid:ETH"
    assert body["hl_meta"]["coin"] == "ETH"


@pytest.mark.parametrize("over,env,status", [
    ({}, {"HYPERLIQUID_ENABLED": "0"}, 503),
    ({}, {"HYPERLIQUID_MASTER_PRIVATE_KEY": ""}, 503),
    # Testnet executor refuses Base/mainnet vault (no from_chain → not 998).
    ({}, {"HYPERLIQUID_TESTNET": "1"}, 409),
    ({"from_chain": "8453"}, {"HYPERLIQUID_TESTNET": "1"}, 409),
    # Mainnet executor refuses HyperEVM Testnet vault.
    ({"from_chain": "998"}, {}, 409),
    ({"zk_proof": {"pA": [1]}}, {}, 400),          # a v1 client proof, not an enclave arm
    ({"asset_in": "ETH"}, {}, 400),
    ({"legs": [{}]}, {}, 400),
    ({"hl_meta": _order(leverage=99)}, {}, 400),
])
def test_create_refuses(attested, monkeypatch, over, env, status):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    refusal = hl.prepare_strategy(_create_body(**over))
    assert refusal and refusal[1] == status


def test_create_allows_hyperevm_testnet_vault_on_hl_testnet(attested, monkeypatch):
    """Option A: 998 vault + HYPERLIQUID_TESTNET=1 arms private perps."""
    monkeypatch.setenv("HYPERLIQUID_TESTNET", "1")
    body = _create_body(from_chain="998")
    assert hl.prepare_strategy(body) is None
    assert body["payout"]["to_chain_id"] == 1337
    assert body["payout"]["to_address"] == ACCOUNT
    assert body["output_mode"] == "bridge"



# ── the position state machine ──────────────────────────────────────────────────────────────────

@pytest.fixture
def ctx():
    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///:memory:"
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    db.init_app(app)
    with app.app_context():
        db.create_all()
        yield
        db.session.rollback()


class FakeHL:
    """The exchange: IOC orders fill at `px` (or are rejected), fills are found by cloid."""

    def __init__(self, px=2000.0):
        self.px = px
        self.orders = []          # (cloid, is_buy, size)
        self.filled = {}          # cloid -> fill
        self.fill_ratio = 1.0
        self.reject = None
        self.paid = []            # (op, amount, destination)
        self.pay_error = None
        self.funding = 0.0

    def order_fills(self, c, since):
        return self.filled.get(c, {"status": "unknownOid", "oid": None, "sz": 0.0, "avg_px": 0.0, "fee": 0.0})

    def place_order(self, coin, *, is_buy, size, order_cloid):
        self.orders.append((order_cloid, is_buy, size))
        if self.reject:
            self.filled[order_cloid] = {"status": "canceled", "oid": 1, "sz": 0.0, "avg_px": 0.0, "fee": 0.0}
            return {"rejected": self.reject}
        sz = hl.round_size(coin, size * self.fill_ratio)
        self.filled[order_cloid] = {"status": "filled" if sz == size else "canceled", "oid": 1,
                                    "sz": sz, "avg_px": self.px, "fee": sz * self.px * 0.0005}
        return {"oid": 1, "filled_sz": sz, "avg_px": self.px}

    def _pay(self, op):
        def pay(amount, destination):
            if self.pay_error:
                raise self.pay_error
            self.paid.append((op, round(amount, 6), destination))
            return {"response": {"status": "ok"}}
        return pay


@pytest.fixture
def ex(monkeypatch):
    fake = FakeHL()
    monkeypatch.setattr(hl, "order_fills", fake.order_fills)
    monkeypatch.setattr(hl, "place_order", fake.place_order)
    monkeypatch.setattr(hl, "mark_px", lambda coin: fake.px)
    monkeypatch.setattr(hl, "all_mids", lambda: {"ETH": fake.px, "BTC": 60_000.0})
    monkeypatch.setattr(hl, "send_usd", fake._pay("send"))
    monkeypatch.setattr(hl, "withdraw", fake._pay("withdraw"))
    monkeypatch.setattr(hl, "funding_usd", lambda *a: fake.funding)
    return fake


def _fired(user=USER, order_status="DONE", amount_out=30_000_000, **meta_over):
    meta = hl.validate_order(_order(**meta_over), amount_out / 1e6, user)
    s = Strategy(user_id=user.lower(), strategy_type="HYPERLIQUID", asset_in="USDC", asset_out="ETH",
                 amount=amount_out / 1e6, recipient_address=user, status="EXECUTED",
                 output_mode="bridge", hl_meta=json.dumps(meta))
    db.session.add(s)
    db.session.flush()
    db.session.add(BridgeOrder(strategy_id=s.id, chain_id=8453, token="0x" + "0" * 40, to_chain_id="1337",
                               to_token="USDC", to_address=ACCOUNT, min_out="1", refund_address=user,
                               status=order_status, amount_out=str(amount_out)))
    db.session.commit()
    w._adopt()
    return HyperliquidPosition.query.filter_by(strategy_id=s.id).one()


def _open(**kw):
    pos = _fired(**kw)
    w._step(pos, {})
    assert pos.status == "OPEN", pos.error
    return pos


def test_adopt_makes_one_funding_position_per_fired_strategy(ctx, ex):
    pos = _fired(order_status="SENT", exit_to={"to_chain_id": 42161, "to_address": OTHER})
    assert (pos.status, pos.coin, pos.side, pos.leverage) == ("FUNDING", "ETH", "LONG", 3)
    assert (pos.payout_chain, pos.payout_address) == (42161, OTHER)
    w._adopt()
    assert HyperliquidPosition.query.count() == 1


def test_funding_waits_then_refund_or_review_follow_the_bridge(ctx, ex):
    pos = _fired(order_status="SENT")
    w._step(pos, {})
    assert pos.status == "FUNDING" and not ex.orders
    order = BridgeOrder.query.get(pos.bridge_order_id)
    order.status = "REFUNDED"
    db.session.commit()
    w._step(pos, {})
    assert pos.status == "REFUNDED" and not ex.orders

    other = _fired(order_status="REVIEW")
    w._step(other, {})
    assert other.status == "REVIEW"


def test_a_reverted_funding_spend_lets_the_next_fire_be_adopted(ctx, ex):
    pos = _fired(order_status="RELAYING")
    first = BridgeOrder.query.get(pos.bridge_order_id)
    first.status = "FAILED"
    db.session.commit()
    w._step(pos, {})
    assert HyperliquidPosition.query.count() == 0
    db.session.add(BridgeOrder(strategy_id=first.strategy_id, chain_id=8453, token=first.token,
                               to_chain_id="1337", to_token="USDC", to_address=ACCOUNT, min_out="1",
                               refund_address=USER, status="SENT"))
    db.session.commit()
    w._adopt()
    again = HyperliquidPosition.query.one()
    assert again.bridge_order_id != first.id and again.status == "FUNDING"


def test_open_sizes_from_delivered_margin_and_records_the_fill(ctx, ex):
    pos = _open(amount_out=30_000_000)  # $30 × 3 / $2000 = 0.045 ETH
    [(c, is_buy, size)] = ex.orders
    assert c == hl.cloid(pos.id, "open", 0) and is_buy and size == 0.045
    assert (pos.entry_size, pos.size, pos.entry_px, pos.margin_usdc) == (0.045, 0.045, 2000.0, "30000000")
    assert pos.fees_usd == pytest.approx(0.045)


def test_a_restarted_executor_finds_its_sent_entry_instead_of_sending_another(ctx, ex):
    pos = _fired()
    w._step(pos, {})  # FUNDING → OPENING → order sent → OPEN
    pos.status, pos.size = "OPENING", 0
    db.session.commit()  # as if the process died before recording the fill
    w._step(pos, {})
    assert pos.status == "OPEN" and len(ex.orders) == 1


def test_unfilled_entries_retry_then_hand_the_margin_back(ctx, ex):
    ex.reject = "Order could not immediately match"
    pos = _fired()
    for _ in range(w.MAX_OPEN_ATTEMPTS):
        w._step(pos, {})
    assert len({c for c, _, _ in ex.orders}) == w.MAX_OPEN_ATTEMPTS  # a fresh cloid each try
    assert pos.status == "SETTLED"  # PAYOUT_DUE paid in the same pass
    assert ex.paid == [("send", 30.0, USER)]


def test_margin_under_the_exchange_minimum_is_handed_back_unopened(ctx, ex):
    pos = _fired(order_status="SENT", amount_out=4_000_000, leverage=3)  # armed: $4 × 3 = $12
    order = BridgeOrder.query.get(pos.bridge_order_id)
    order.status, order.amount_out = "DONE", "3000000"                  # landed: $3 × 3 = $9
    db.session.commit()
    w._step(pos, {})
    assert not ex.orders and pos.status == "SETTLED" and ex.paid == [("send", 3.0, USER)]


def test_take_profit_closes_exactly_this_size_and_pays_margin_plus_pnl(ctx, ex):
    pos = _open(take_profit_px=2100)
    ex.px = 2100.0
    ex.funding = 0.02
    w._step(pos, {"ETH": 2100.0})
    (_, buy0, _), (c, is_buy, size) = ex.orders
    assert c == hl.cloid(pos.id, "close", 0) and not is_buy and size == 0.045
    assert pos.close_reason == "tp" and pos.status == "SETTLED"
    pnl = 0.045 * 100
    fees = 0.045 * 2000 * 0.0005 + 0.045 * 2100 * 0.0005
    assert pos.realized_pnl == pytest.approx(pnl)
    assert ex.paid == [("send", pytest.approx(30 + pnl - fees - 0.02, abs=1e-6), USER)]


def test_short_stop_loss_buys_back_and_loses(ctx, ex):
    pos = _open(side="SHORT", take_profit_px=1800, stop_loss_px=2200)
    assert ex.orders[0][1] is False  # entered by selling
    ex.px = 2200.0
    w._step(pos, {"ETH": 2200.0})
    assert pos.close_reason == "sl" and ex.orders[1][1] is True
    assert pos.realized_pnl == pytest.approx(-0.045 * 200)


def test_the_guard_closes_before_the_margin_is_gone(ctx, ex):
    pos = _open(take_profit_px=None, stop_loss_px=None)
    assert w._exit_reason(pos, 1700.0) is None              # equity $16.45 > $9
    ex.px = 1500.0
    w._step(pos, {"ETH": 1500.0})                            # equity $7.46 <= 30% of $30
    assert pos.close_reason == "guard" and pos.status == "SETTLED"


def test_a_loss_beyond_the_margin_pays_nothing(ctx, ex):
    pos = _open(take_profit_px=None, stop_loss_px=None)
    ex.px = 1000.0
    w._step(pos, {"ETH": 1000.0})
    assert pos.payout_usdc == "0" and pos.payout_ref == "nothing owed" and not ex.paid


def test_partial_exit_fills_retry_with_a_fresh_cloid(ctx, ex):
    pos = _open(take_profit_px=None, stop_loss_px=None)
    ex.fill_ratio = 0.5
    assert w._claim(pos, "OPEN", status="CLOSING", attempts=0, close_reason="user")
    w._close(pos)
    assert pos.status == "CLOSING" and pos.size == pytest.approx(0.0225) and pos.attempts == 1
    ex.fill_ratio = 1.0
    w._step(pos, {})
    assert pos.status == "SETTLED"
    closes = [o for o in ex.orders[1:]]
    assert [c for c, _, _ in closes] == [hl.cloid(pos.id, "close", 0), hl.cloid(pos.id, "close", 1)]
    assert closes[1][2] == pytest.approx(0.0225)


def test_a_restarted_close_reads_its_fill_instead_of_selling_twice(ctx, ex):
    pos = _open(take_profit_px=None, stop_loss_px=None)
    assert w._claim(pos, "OPEN", status="CLOSING", attempts=0, close_reason="user")
    c = hl.cloid(pos.id, "close", 0)
    ex.filled[c] = {"status": "filled", "oid": 9, "sz": 0.045, "avg_px": 2000.0, "fee": 0.04}
    w._step(pos, {})
    assert len(ex.orders) == 1 and pos.status == "SETTLED"


def test_users_on_one_coin_close_their_own_size_and_side(ctx, ex):
    a = _open(take_profit_px=None, stop_loss_px=None)
    b = _open(user=OTHER, side="SHORT", take_profit_px=None, stop_loss_px=None, amount_out=60_000_000)
    w.exit_position(a)
    assert ex.orders[-1][1:] == (False, 0.045)               # A sells its own 0.045
    assert b.status == "OPEN" and b.size == 0.09
    w.exit_position(b)
    assert ex.orders[-1][1:] == (True, 0.09)                 # B buys back its own 0.09
    assert [p[2] for p in ex.paid] == [USER, OTHER]


def test_arbitrum_payouts_withdraw_unless_the_fee_would_eat_them(ctx, ex):
    pos = _open(exit_to={"to_chain_id": 42161, "to_address": OTHER}, take_profit_px=None, stop_loss_px=None)
    w.exit_position(pos)
    assert ex.paid[0][0] == "withdraw" and pos.payout_ref.startswith("withdraw3")
    small = _open(exit_to={"to_chain_id": 42161, "to_address": OTHER}, take_profit_px=None,
                  stop_loss_px=None, amount_out=4_000_000, leverage=3)
    ex.px = 1500.0
    w._step(small, {"ETH": 1500.0})                          # guard: ~$1.0 left
    assert ex.paid[-1][0] == "send" and small.payout_chain == 1337


def test_payout_refusals_retry_unknown_outcomes_go_to_review(ctx, ex):
    ex.pay_error = RuntimeError("hyperliquid refused: {'status': 'err'}")
    pos = _open(take_profit_px=None, stop_loss_px=None)
    w.exit_position(pos)
    assert pos.status == "PAYOUT_DUE" and pos.attempts == 1
    for _ in range(w.MAX_PAY_ATTEMPTS - 1):
        w._step(pos, {})
    assert pos.status == "REVIEW" and not ex.paid

    ex.pay_error = TimeoutError("read timed out")
    other = _open(user=OTHER, take_profit_px=None, stop_loss_px=None)
    w.exit_position(other)
    assert other.status == "REVIEW"


def test_an_unconfigured_payout_waits(ctx, ex):
    ex.pay_error = hl.HyperliquidNotConfigured("HYPERLIQUID_MASTER_PRIVATE_KEY not set")
    pos = _open(take_profit_px=None, stop_loss_px=None)
    w.exit_position(pos)
    assert pos.status == "PAYOUT_DUE"
    ex.pay_error = None
    w._step(pos, {})
    assert pos.status == "SETTLED" and len(ex.paid) == 1


def test_a_payout_in_flight_at_restart_is_never_sent_again(ctx, ex):
    pos = _open(take_profit_px=None, stop_loss_px=None)
    pos.status, pos.payout_usdc = "PAYING", "30000000"
    db.session.commit()
    w._step(pos, {})
    assert pos.status == "REVIEW" and not ex.paid


def test_exit_needs_an_open_position(ctx, ex):
    pos = _fired(order_status="SENT")
    with pytest.raises(RuntimeError, match="not OPEN"):
        w.exit_position(pos)
    opened = _open(user=OTHER)
    w.exit_position(opened)
    with pytest.raises(RuntimeError, match="not OPEN"):
        w.exit_position(opened)
    assert len(ex.paid) == 1


def test_the_scheduler_pass_runs_only_when_configured(ctx, ex, monkeypatch):
    monkeypatch.setattr(w, "_WATCH_INTERVAL", 0.0)
    pos = _fired()
    monkeypatch.delenv("HYPERLIQUID_MASTER_PRIVATE_KEY")
    w.process_open_positions()
    assert not ex.orders
    monkeypatch.setenv("HYPERLIQUID_MASTER_PRIVATE_KEY", "0x" + "11" * 32)
    w.process_open_positions()
    db.session.refresh(pos)
    assert pos.status == "OPEN"


def test_a_missing_mark_never_borrows_another_price():
    import scheduler

    s = {"asset_in": "USDC", "asset_out": "BTC", "price_feed_id": "hyperliquid:BTC"}
    assert scheduler._price_for(s, {"eth-feed": 3000.0}, "eth-feed", 3000.0, 150.0) is None
    assert scheduler._price_for(s, {"hyperliquid:BTC": 60_000.0}, "eth-feed", 3000.0, 150.0) == 60_000.0
