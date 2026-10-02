"""Withdrawal-fee credit: validation, and the replay guard arming_fee.py does not have."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import withdraw_credit as wc

WALLET = "0x57fBC5C7e1A40134eC3cE2fe06EBD26d9C7267A2"
COLLECTOR = "0x5830A431E6866B8F8a605625b0713D8190FB06bA"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def _transfer(**over):
    base = {"status": 1, "token": USDC, "sender": WALLET, "recipient": COLLECTOR, "amount": 500_000}
    base.update(over)
    return base


def test_valid_topup_credits_what_the_chain_moved():
    assert wc.validate_topup_transfer(_transfer(), wallet=WALLET, collector=COLLECTOR, usdc=USDC) == 500_000


def test_overpayment_is_credited_in_full():
    # The ledger records what arrived, never what was asked for — same rule as arming_fee.
    got = wc.validate_topup_transfer(_transfer(amount=10_000_000), wallet=WALLET, collector=COLLECTOR, usdc=USDC)
    assert got == 10_000_000


@pytest.mark.parametrize("over,why", [
    ({"status": 0}, "reverted"),
    ({"token": "0x0000000000000000000000000000000000000001"}, "wrong token"),
    ({"sender": "0x000000000000000000000000000000000000dEaD"}, "someone else's transfer"),
    ({"recipient": "0x000000000000000000000000000000000000dEaD"}, "wrong collector"),
    ({"amount": 0}, "moved nothing"),
])
def test_rejects_bad_topups(over, why):
    with pytest.raises(ValueError):
        wc.validate_topup_transfer(_transfer(**over), wallet=WALLET, collector=COLLECTOR, usdc=USDC)


def test_address_comparison_is_case_insensitive():
    # Checksummed vs lowercase must not be treated as different wallets, or a legitimate top-up
    # is rejected depending on how the client happened to format the address.
    assert wc.validate_topup_transfer(
        _transfer(sender=WALLET.lower(), recipient=COLLECTOR.upper().replace("0X", "0x")),
        wallet=WALLET, collector=COLLECTOR, usdc=USDC,
    ) == 500_000


def test_disabled_by_default():
    os.environ.pop("V3_WITHDRAW_FEE_ENABLED", None)
    assert wc.enabled() is False, "must default OFF or a deploy-order mismatch blocks every exit"


def test_enable_flag_accepts_the_usual_spellings():
    for v in ("1", "true", "YES", "on"):
        os.environ["V3_WITHDRAW_FEE_ENABLED"] = v
        assert wc.enabled() is True
    os.environ["V3_WITHDRAW_FEE_ENABLED"] = "0"
    assert wc.enabled() is False


def test_fee_parses_and_falls_back():
    os.environ["V3_WITHDRAW_FEE_USDC"] = "0.25"
    assert wc.fee_wei() == 250_000
    os.environ["V3_WITHDRAW_FEE_USDC"] = "not-a-number"
    assert wc.fee_wei() == 50_000  # falls back rather than charging 0 or crashing the relay
    os.environ.pop("V3_WITHDRAW_FEE_USDC", None)
