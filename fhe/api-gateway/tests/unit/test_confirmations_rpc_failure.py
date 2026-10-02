"""An unreachable RPC is not an unconfirmed payment.

is_confirmed() used to swallow every exception into False, so an exhausted API key or a network
blip was reported to the user as "Payment transaction is missing, failed, or not yet confirmed" —
a sentence about their money, for a problem on our side, about a payment already on-chain. It also
made a transient fault look permanent, which is what stops someone from simply retrying.

These pin the split: a real negative from the chain stays False; an unreachable node raises 503.
"""
import pytest
from unittest.mock import MagicMock, patch
from web3.exceptions import TransactionNotFound

from app.errors import DownstreamUnavailable
from app.services import confirmations


def _w3(receipt=None, block=None, exc=None):
    w3 = MagicMock()
    if exc is not None:
        w3.eth.get_transaction_receipt.side_effect = exc
    else:
        w3.eth.get_transaction_receipt.return_value = receipt
        w3.eth.block_number = block
    return w3


TX = "0x" + "ab" * 32


def test_unreachable_rpc_raises_rather_than_denying_the_payment():
    # The real shape of this failure: Alchemy answering "Monthly capacity limit exceeded".
    with patch.object(confirmations, "Web3") as W:
        W.HTTPProvider.return_value = object()
        W.return_value = _w3(exc=Exception("429 Monthly capacity limit exceeded"))
        with pytest.raises(DownstreamUnavailable):
            confirmations.is_confirmed(8453, TX)


def test_missing_tx_is_a_real_negative():
    with patch.object(confirmations, "Web3") as W:
        W.HTTPProvider.return_value = object()
        W.return_value = _w3(exc=TransactionNotFound("not found"))
        assert confirmations.is_confirmed(8453, TX) is False


def test_unconfigured_chain_raises_rather_than_denying():
    # get_rpc_url returns None for an unsupported chain; that is our misconfiguration, not their
    # payment failing. Returning False here blamed the user for an empty env var.
    with pytest.raises(DownstreamUnavailable):
        confirmations.is_confirmed(999999, TX)


def test_reverted_tx_is_a_real_negative():
    with patch.object(confirmations, "Web3") as W:
        W.HTTPProvider.return_value = object()
        W.return_value = _w3(receipt={"status": 0, "blockNumber": 10}, block=100)
        assert confirmations.is_confirmed(8453, TX) is False


@pytest.mark.parametrize(
    "tx_block, head, expected",
    [
        (100, 100, False),  # 0 confirmations — mined this block
        (100, 101, False),  # 1 confirmation  — exactly what tx.wait() returns, and NOT enough
        (100, 102, True),   # 2 confirmations — the configured requirement
        (100, 150, True),
    ],
)
def test_confirmation_depth_boundary(tx_block, head, expected):
    # The 1-vs-2 gap is the whole bug: the client posts at one confirmation, so a fresh payment
    # always lands on the False row and used to be told its payment had failed.
    with patch.object(confirmations, "Web3") as W:
        W.HTTPProvider.return_value = object()
        W.return_value = _w3(receipt={"status": 1, "blockNumber": tx_block}, block=head)
        assert confirmations.is_confirmed(8453, TX) is expected
