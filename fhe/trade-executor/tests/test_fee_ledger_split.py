"""The single arming transfer is recorded as its two priced legs.

The pricing sheet bills arming and the execution window as separate line items, but the user
sends ONE USDC transfer. app.py splits it so /admin/fees can report what was actually charged
instead of one opaque "arming" lump — and the split must not break the replay guard, which is a
partial unique index on (tx_hash) WHERE kind = 'arming'.
"""
import pytest
from flask import Flask
from sqlalchemy import text

from arming_fee import ARMING_ONLY_USDC_WEI
from database import db, FeeAccrual


@pytest.fixture
def app_ctx():
    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///:memory:"
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    db.init_app(app)
    with app.app_context():
        db.create_all()
        # The same partial index app.py creates at boot.
        db.session.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_accruals_arming_tx_hash "
            "ON fee_accruals(tx_hash) WHERE kind = 'arming' AND tx_hash IS NOT NULL"
        ))
        db.session.commit()
        yield
        db.session.rollback()


def record_transfer(paid_wei: int, tx_hash: str, strategy_id: str = "s1") -> None:
    """The block app.py runs after a verified arming transfer."""
    arming_wei = min(paid_wei, ARMING_ONLY_USDC_WEI)
    common = dict(chain_id=8453, asset="USDC", strategy_id=strategy_id,
                  tx_hash=tx_hash, swept=True)
    db.session.add(FeeAccrual(amount_wei=str(arming_wei), kind="arming", **common))
    if paid_wei > arming_wei:
        db.session.add(FeeAccrual(amount_wei=str(paid_wei - arming_wei), kind="window", **common))
    db.session.commit()


def legs() -> dict:
    return {r.kind: int(r.amount_wei) for r in FeeAccrual.query.all()}


def test_a_24h_order_splits_into_arming_and_window(app_ctx):
    record_transfer(750_000, "0xaa")           # $0.25 arming + $0.50 window
    assert legs() == {"arming": 250_000, "window": 500_000}


def test_the_legs_always_add_back_up_to_what_was_transferred(app_ctx):
    for paid in (500_000, 750_000, 2_250_000, 5_250_000):
        FeeAccrual.query.delete()
        db.session.commit()
        record_transfer(paid, f"0x{paid:x}")
        assert sum(legs().values()) == paid


def test_a_pre_cutover_quarter_dollar_transfer_has_no_window_leg(app_ctx):
    record_transfer(250_000, "0xbb")
    assert legs() == {"arming": 250_000}


def test_an_overpayment_lands_on_the_window_leg(app_ctx):
    # Accepted so the browser and executor can deploy in either order; the surplus is still
    # recorded rather than being silently dropped from the ledger.
    record_transfer(1_000_000, "0xcc")
    assert legs() == {"arming": 250_000, "window": 750_000}


def test_the_replay_guard_survives_the_split(app_ctx):
    record_transfer(750_000, "0xdd", strategy_id="s1")
    # A second strategy must not be able to reuse the same confirmed transfer.
    with pytest.raises(Exception):
        record_transfer(750_000, "0xdd", strategy_id="s2")
    db.session.rollback()


def test_the_window_leg_does_not_trip_the_arming_index(app_ctx):
    # Two DIFFERENT strategies each add a window row; only the arming rows are constrained.
    record_transfer(750_000, "0xee", strategy_id="s1")
    record_transfer(750_000, "0xff", strategy_id="s2")
    assert FeeAccrual.query.filter_by(kind="window").count() == 2
    assert FeeAccrual.query.filter_by(kind="arming").count() == 2
