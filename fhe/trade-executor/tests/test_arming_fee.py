import pytest

import arming_fee
import fee_calc
import fee_config


WALLET = "0x0000000000000000000000000000000000000001"
EXECUTOR = "0x0000000000000000000000000000000000000002"
USDC = "0x0000000000000000000000000000000000000003"


@pytest.fixture
def window_fees_on(monkeypatch):
    """The window fee ships behind a flag so the browser and the executor can deploy in either
    order; these cases are about what happens once it is turned on."""
    monkeypatch.setattr(fee_config, "WINDOW_FEE_ENABLED", True)
    monkeypatch.setattr(fee_config, "FEE_ENABLED", True)


def _transfer(*, sender=WALLET, recipient=EXECUTOR, amount=250_000, token=USDC, status=1):
    return {
        "status": status,
        "sender": sender,
        "recipient": recipient,
        "amount": amount,
        "token": token,
    }


def test_bare_arming_fee_is_a_quarter_usdc():
    assert arming_fee.required_arming_fee_usdc_wei() == 250_000


def test_valid_transfer_is_accepted():
    assert arming_fee.validate_arming_transfer(
        _transfer(), wallet=WALLET, executor=EXECUTOR, usdc=USDC
    ) == {"amount_wei": "250000", "asset": "USDC"}


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("status", 0, "reverted"),
        ("sender", EXECUTOR, "sender"),
        ("recipient", WALLET, "recipient"),
        ("amount", 249_999, "at least"),
        ("token", WALLET, "USDC contract"),
    ],
)
def test_invalid_transfer_is_rejected(field, value, message):
    transfer = _transfer()
    transfer[field] = value
    with pytest.raises(ValueError, match=message):
        arming_fee.validate_arming_transfer(
            transfer, wallet=WALLET, executor=EXECUTOR, usdc=USDC
        )


# ── window pricing ───────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("window_hours", "expected_usdc_wei"),
    [
        (0,     500_000),    # no window stated -> shortest tier, priced the same as 1h
        (1,     500_000),    # 0.25 arming + 0.25 window
        (2,     750_000),    # 0.25 + 0.50 (24h tier)
        (24,    750_000),
        (25,  2_250_000),    # 0.25 + 2.00 (7d tier)
        (168, 2_250_000),
        (169, 5_250_000),    # 0.25 + 5.00 (30d tier)
        (720, 5_250_000),
        (5_000, 5_250_000),  # longer than the last tier still pays the last tier
    ],
)
def test_required_fee_follows_the_window_tier(window_fees_on, window_hours, expected_usdc_wei):
    assert arming_fee.required_arming_fee_usdc_wei(window_hours) == expected_usdc_wei


def test_window_comes_from_execution_window_sec(window_fees_on):
    assert arming_fee.window_hours_from_request({"execution_window_sec": 86_400}) == 24
    # Absent or unparseable means the shortest tier, never a free pass or a crash.
    assert arming_fee.window_hours_from_request({}) == 0
    assert arming_fee.window_hours_from_request({"execution_window_sec": "abc"}) == 0
    assert arming_fee.window_hours_from_request({"execution_window_sec": None}) == 0


def test_underpaying_the_window_is_rejected(window_fees_on):
    required = arming_fee.required_arming_fee_usdc_wei(24)  # $0.75
    with pytest.raises(ValueError, match="at least 0.75 USDC"):
        arming_fee.validate_arming_transfer(
            _transfer(amount=250_000),  # the pre-cutover $0.25
            wallet=WALLET, executor=EXECUTOR, usdc=USDC, required_wei=required,
        )


def test_overpaying_is_accepted_and_recorded_at_what_actually_arrived(window_fees_on):
    # A frontend that already sends arming+window must not be rejected while the flag is still
    # off — that is what makes the two deploys order-independent. The ledger records the real
    # amount rather than the constant that was asked for.
    result = arming_fee.validate_arming_transfer(
        _transfer(amount=750_000),
        wallet=WALLET, executor=EXECUTOR, usdc=USDC, required_wei=250_000,
    )
    assert result == {"amount_wei": "750000", "asset": "USDC"}


def test_flag_off_keeps_the_pre_cutover_price(monkeypatch):
    monkeypatch.setattr(fee_config, "FEE_ENABLED", True)
    monkeypatch.setattr(fee_config, "WINDOW_FEE_ENABLED", False)
    assert fee_calc.window_fee_usd(720) == 0.0
    assert arming_fee.required_arming_fee_usdc_wei(720) == 250_000


def test_fees_disabled_charges_nothing(monkeypatch):
    monkeypatch.setattr(fee_config, "FEE_ENABLED", False)
    assert arming_fee.required_arming_fee_usdc_wei(24) == 0
