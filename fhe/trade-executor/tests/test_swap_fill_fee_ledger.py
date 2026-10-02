"""Recovering the on-chain fill fee from a swapAndDeposit receipt.

The Entrypoint skims `swapAndDepositFeeBps` from the measured swap OUTPUT and pulls it straight to
the collector. That skim emits no event of its own, and unlike the withdrawal fee it never lands
in a vault pull-payment balance — so nothing in fee_accruals or withdraw_fee_ledger sees it and
/admin/fees would report the fill leg as zero forever. The only trace is the ERC20
Transfer(vault -> collector) inside the executor's own receipt.
"""
import pytest
from flask import Flask

from database import db, FeeAccrual
from fee_ledger import record_swap_and_deposit_fee, _TRANSFER_TOPIC

USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
VAULT = "0xd7030f84D6A49465a2C5c60e3581848bAF38686F"
COLLECTOR = "0x5830A431E6866B8F8a605625b0713D8190FB06bA"
OTHER = "0x00000000000000000000000000000000000000ff"
TX = "0x" + "ab" * 32


class _Hex(bytes):
    """web3 returns HexBytes for topics/data; mimic just the .hex() the parser uses."""
    def hex(self):
        return super().hex()


def _topic(address_or_topic: str) -> _Hex:
    return _Hex(bytes.fromhex(address_or_topic.lower().replace("0x", "").rjust(64, "0")))


def _transfer_log(token: str, to: str, amount: int, sender: str = VAULT) -> dict:
    return {
        "address": token,
        "topics": [_topic(_TRANSFER_TOPIC), _topic(sender), _topic(to)],
        "data": _Hex(amount.to_bytes(32, "big")),
    }


class FakeW3:
    def __init__(self, logs):
        self.eth = self
        self._logs = logs

    def get_transaction_receipt(self, _tx):
        return {"logs": self._logs}


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


def rows():
    return [(r.kind, r.asset, int(r.amount_wei)) for r in FeeAccrual.query.all()]


def test_the_skim_is_recovered_from_the_receipt(app_ctx):
    # 0.20% of a 100 USDC output = 0.2 USDC.
    w3 = FakeW3([_transfer_log(USDC, COLLECTOR, 200_000)])
    record_swap_and_deposit_fee(w3, 8453, TX, dst_token=USDC, dst_symbol="USDC",
                                collector=COLLECTOR, strategy_id="s1")
    assert rows() == [("fill", "USDC", 200_000)]


def test_the_user_leg_of_the_same_swap_is_not_counted_as_fee(app_ctx):
    # The vault also moves the net output around; only transfers TO the collector are the fee.
    w3 = FakeW3([
        _transfer_log(USDC, OTHER, 99_800_000),      # not the collector
        _transfer_log(USDC, COLLECTOR, 200_000),     # the skim
    ])
    record_swap_and_deposit_fee(w3, 8453, TX, dst_token=USDC, dst_symbol="USDC",
                                collector=COLLECTOR, strategy_id="s1")
    assert rows() == [("fill", "USDC", 200_000)]


def test_a_transfer_of_a_different_token_is_ignored(app_ctx):
    w3 = FakeW3([_transfer_log(OTHER, COLLECTOR, 5_000_000)])
    record_swap_and_deposit_fee(w3, 8453, TX, dst_token=USDC, dst_symbol="USDC",
                                collector=COLLECTOR, strategy_id="s1")
    assert rows() == []


def test_a_native_output_records_nothing_rather_than_a_wrong_number(app_ctx):
    # pullAssets on a native vault is a raw ETH send with no log. Better to record nothing and say
    # so than to invent a figure — the report must not show a confident zero either.
    w3 = FakeW3([])
    assert record_swap_and_deposit_fee(
        w3, 8453, TX, dst_token="ETH", dst_symbol="ETH", collector=COLLECTOR) is None
    assert rows() == []


def test_fee_off_records_nothing(app_ctx):
    # swapAndDepositFeeBps = 0 -> no transfer to the collector at all.
    w3 = FakeW3([_transfer_log(USDC, OTHER, 100_000_000)])
    assert record_swap_and_deposit_fee(
        w3, 8453, TX, dst_token=USDC, dst_symbol="USDC", collector=COLLECTOR) is None
    assert rows() == []


def test_it_never_raises_into_the_execution_path(app_ctx):
    class Boom:
        eth = property(lambda self: (_ for _ in ()).throw(RuntimeError("rpc down")))
    # The trade has already settled; a ledger problem must not surface as a failed execution.
    assert record_swap_and_deposit_fee(
        Boom(), 8453, TX, dst_token=USDC, dst_symbol="USDC", collector=COLLECTOR) is None
    assert record_swap_and_deposit_fee(
        FakeW3([]), 8453, None, dst_token=USDC, dst_symbol="USDC", collector=COLLECTOR) is None
