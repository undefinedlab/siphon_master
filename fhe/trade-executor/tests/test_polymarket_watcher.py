"""Unit tests for polymarket_watcher — early exit (full/partial) and the resolution
state machine, with the chain/CLOB/bridge seams monkeypatched and an in-memory DB.
"""
import json

import pytest
from flask import Flask

from database import db, PolymarketPosition, Strategy
import polymarket_client
import polymarket_watcher
from polymarket_watcher import exit_position, _process_one


@pytest.fixture
def app_ctx():
    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///:memory:"
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    db.init_app(app)
    with app.app_context():
        db.create_all()
        yield
        db.session.rollback()


def make_position(**overrides) -> PolymarketPosition:
    defaults = dict(
        strategy_id="strat-1",
        user_id="0xuser",
        market_id="mkt-1",
        token_id="tok-1",
        outcome="Yes",
        side="BUY",
        entry_odds=0.5,
        shares="100",
        cost_usdc="50000000",  # $50
        output_precommitment="12345",
        status="OPEN",
    )
    defaults.update(overrides)
    pos = PolymarketPosition(**defaults)
    db.session.add(pos)
    db.session.commit()
    return pos


class BalanceSeq:
    """usdc_e_balance stub: first call returns `before`, later calls `after`."""

    def __init__(self, before: int, after: int):
        self.before, self.after, self.calls = before, after, 0

    def __call__(self, _addr):
        self.calls += 1
        return self.before if self.calls == 1 else self.after


@pytest.fixture
def exit_seams(monkeypatch):
    """Happy-path seams for exit_position; tests override pieces as needed."""
    calls = {}
    monkeypatch.setattr(polymarket_client, "is_configured", lambda: True)
    monkeypatch.setattr(polymarket_client, "executor_polygon_address", lambda: "0xEsc")
    monkeypatch.setattr(polymarket_client, "usdc_e_balance", BalanceSeq(0, 40_000_000))
    monkeypatch.setattr(polymarket_client, "market_price", lambda t, s: 0.62)
    def sell(token_id, price, shares):
        calls["sell"] = (token_id, price, shares)
        return {"order_id": "ord-1"}

    monkeypatch.setattr(polymarket_client, "sell_shares", sell)

    def bridge(dest_cid, payout_wei, precommitment):
        calls["bridge"] = (dest_cid, payout_wei, precommitment)
        return "0xsettle", payout_wei - 1000

    monkeypatch.setattr(polymarket_watcher, "_bridge_and_deposit", bridge)
    monkeypatch.setattr(polymarket_watcher.time, "sleep", lambda s: None)
    return calls


# ── exit_position ───────────────────────────────────────────────────────────────────────────

def test_full_exit_closes_position_and_shields_to_original_note(app_ctx, exit_seams):
    pos = make_position()
    result = exit_position(pos, fraction=1.0)

    assert pos.status == "CLOSED"
    assert pos.settle_tx == "0xsettle"
    assert pos.payout_usdc == "40000000"
    # sold ALL shares, shielded to the position's ORIGINAL note
    assert exit_seams["sell"] == ("tok-1", 0.62, 100.0)
    assert exit_seams["bridge"] == (8453, 40_000_000, "12345")
    assert result["status"] == "CLOSED"
    assert result["order_id"] == "ord-1"


def test_fraction_above_one_is_a_full_close(app_ctx, exit_seams):
    pos = make_position()
    exit_position(pos, fraction=5.0)
    assert pos.status == "CLOSED"
    assert exit_seams["sell"][2] == 100.0


def test_partial_exit_keeps_position_open_and_uses_fresh_note(app_ctx, exit_seams):
    pos = make_position()
    result = exit_position(pos, fraction=0.4, new_precommitment="99999")

    assert pos.status == "OPEN"
    assert float(pos.shares) == pytest.approx(60.0)
    # cost basis reduced proportionally: 50e6 * (1 - 0.4)
    assert int(pos.cost_usdc) == 30_000_000
    # the ORIGINAL note stays reserved for the remainder; sold portion → FRESH note
    assert pos.output_precommitment == "12345"
    assert exit_seams["sell"][2] == pytest.approx(40.0)
    assert exit_seams["bridge"][2] == "99999"
    assert result["status"] == "OPEN"


def test_partial_exit_without_fresh_note_is_rejected(app_ctx, exit_seams):
    pos = make_position()
    with pytest.raises(RuntimeError, match="output_precommitment"):
        exit_position(pos, fraction=0.5, new_precommitment=None)
    assert pos.status == "OPEN"
    assert "sell" not in exit_seams  # nothing was sold


def test_exit_rejects_non_open_position(app_ctx, exit_seams):
    pos = make_position(status="SETTLED")
    with pytest.raises(RuntimeError, match="not OPEN"):
        exit_position(pos)


def test_exit_rejects_zero_fraction(app_ctx, exit_seams):
    pos = make_position()
    with pytest.raises(RuntimeError, match="fraction"):
        exit_position(pos, fraction=0)


def test_exit_rejects_position_without_shares(app_ctx, exit_seams):
    pos = make_position(shares=None)
    with pytest.raises(RuntimeError, match="no shares"):
        exit_position(pos)


def test_exit_unfilled_sell_leaves_position_open(app_ctx, exit_seams, monkeypatch):
    pos = make_position()
    monkeypatch.setattr(polymarket_client, "usdc_e_balance", lambda a: 7)  # no delta, ever
    monkeypatch.setattr(polymarket_watcher, "_EXIT_FILL_WAIT_SEC", 0)
    with pytest.raises(RuntimeError, match="did not fill"):
        exit_position(pos)
    assert pos.status == "OPEN"
    assert pos.settle_tx is None
    assert "bridge" not in exit_seams  # never bridged unfilled proceeds


def test_full_exit_bridge_crash_is_recoverable(app_ctx, exit_seams, monkeypatch):
    """A crash after the sell but during the bridge must leave the row in REDEEMING with the
    payout recorded — the watcher's existing recovery then retries bridge+deposit, never re-sells."""
    pos = make_position()

    def boom(dest_cid, payout_wei, precommitment):
        raise RuntimeError("bridge down")

    monkeypatch.setattr(polymarket_watcher, "_bridge_and_deposit", boom)
    with pytest.raises(RuntimeError, match="bridge down"):
        exit_position(pos)

    assert pos.status == "REDEEMING"
    assert pos.payout_usdc == "40000000"
    assert pos.redeem_tx == "ord-1"
    assert pos.settle_tx is None  # exactly the shape _process_one's REDEEMING recovery resumes


def test_partial_exit_bridge_crash_commits_share_reduction(app_ctx, exit_seams, monkeypatch):
    """The sell happened — the row must reflect the reduced holdings even if shielding failed."""
    pos = make_position()

    def boom(dest_cid, payout_wei, precommitment):
        raise RuntimeError("bridge down")

    monkeypatch.setattr(polymarket_watcher, "_bridge_and_deposit", boom)
    with pytest.raises(RuntimeError, match="bridge down"):
        exit_position(pos, fraction=0.4, new_precommitment="99999")

    assert pos.status == "OPEN"
    assert float(pos.shares) == pytest.approx(60.0)  # committed before the bridge
    assert pos.settle_tx is None


# ── resolution state machine (_process_one) ─────────────────────────────────────────────────

@pytest.fixture
def resolution_seams(monkeypatch):
    calls = {}
    monkeypatch.setattr(polymarket_watcher, "_condition_id_for", lambda pos: "0x" + "c" * 64)
    monkeypatch.setattr(polymarket_client, "executor_polygon_address", lambda: "0xEsc")
    monkeypatch.setattr(polymarket_client, "redeem_positions", lambda cid, tok: "0xredeem")

    def bridge(dest_cid, payout_wei, precommitment):
        calls["bridge"] = (dest_cid, payout_wei, precommitment)
        return "0xsettle", payout_wei

    monkeypatch.setattr(polymarket_watcher, "_bridge_and_deposit", bridge)
    return calls


def test_open_position_unresolved_market_is_untouched(app_ctx, resolution_seams, monkeypatch):
    monkeypatch.setattr(polymarket_client, "is_resolved", lambda cid: False)
    pos = make_position()
    _process_one(pos)
    assert pos.status == "OPEN"
    assert pos.redeem_tx is None


def test_resolved_win_redeems_and_shields(app_ctx, resolution_seams, monkeypatch):
    monkeypatch.setattr(polymarket_client, "is_resolved", lambda cid: True)
    monkeypatch.setattr(polymarket_client, "usdc_e_balance", BalanceSeq(0, 90_000_000))
    pos = make_position()
    _process_one(pos)
    assert pos.status == "SETTLED"
    assert pos.redeem_tx == "0xredeem"
    assert pos.payout_usdc == "90000000"
    assert resolution_seams["bridge"] == (8453, 90_000_000, "12345")
    assert pos.settle_tx == "0xsettle"


def test_resolved_loss_settles_with_zero_payout(app_ctx, resolution_seams, monkeypatch):
    monkeypatch.setattr(polymarket_client, "is_resolved", lambda cid: True)
    monkeypatch.setattr(polymarket_client, "usdc_e_balance", lambda a: 0)
    pos = make_position()
    _process_one(pos)
    assert pos.status == "SETTLED"
    assert pos.payout_usdc == "0"
    assert "bridge" not in resolution_seams  # nothing to shield


def test_redeeming_crash_recovery_retries_shield_only(app_ctx, resolution_seams):
    pos = make_position(status="REDEEMING", redeem_tx="0xredeem", payout_usdc="5000000")
    _process_one(pos)
    assert pos.status == "SETTLED"
    assert resolution_seams["bridge"] == (8453, 5_000_000, "12345")


def test_redeeming_already_settled_is_idempotent(app_ctx, resolution_seams):
    pos = make_position(status="REDEEMING", redeem_tx="0xredeem",
                        payout_usdc="5000000", settle_tx="0xdone")
    _process_one(pos)
    assert "bridge" not in resolution_seams  # must not double-shield


def test_missing_precommitment_settles_without_bridging(app_ctx, resolution_seams, monkeypatch):
    monkeypatch.setattr(polymarket_client, "is_resolved", lambda cid: True)
    monkeypatch.setattr(polymarket_client, "usdc_e_balance", BalanceSeq(0, 1_000_000))
    pos = make_position(output_precommitment=None)
    _process_one(pos)
    assert pos.status == "SETTLED"
    assert "bridge" not in resolution_seams  # funds parked, never bridged blind
    assert pos.settle_tx is None


def test_condition_id_prefers_strategy_poly_meta(app_ctx, monkeypatch):
    strat = Strategy(
        id="strat-1", user_id="0xuser", strategy_type="POLYMARKET",
        asset_in="USDC", asset_out="USDC", amount=50.0, recipient_address="0xr",
        poly_meta=json.dumps({"condition_id": "0xabc"}),
    )
    db.session.add(strat)
    pos = make_position()
    monkeypatch.setattr(
        polymarket_client, "condition_id_for_token",
        lambda tok: pytest.fail("should not hit Gamma when poly_meta has condition_id"),
    )
    assert polymarket_watcher._condition_id_for(pos) == "0xabc"
