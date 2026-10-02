"""Arming fees paid by an EIP-7702-delegated wallet.

MetaMask smart accounts route an ERC-20 transfer through a batcher, so the transaction's `to` is
not the token and its selector is not `transfer()`. Verifying by calldata rejected a payment that
had actually landed, with "Could not find any function with matching selector". Verification reads
the Transfer log instead — which also proves the tokens moved, where calldata only states intent.
"""
import arming_fee

USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
WALLET = "0xc5b7b574EE84A9B59B475FE32Eaf908C246d3859"
EXECUTOR = "0x5830A431E6866B8F8a605625b0713D8190FB06bA"
OTHER_TOKEN = "0x5Abf63CA0c01AF3d8fd4A1CC2e79f7E26B67B66A"


def _log(token, sender, recipient, amount):
    pad = lambda a: "0x" + "0" * 24 + a[2:].lower()
    return {"address": token, "data": hex(amount),
            "topics": [arming_fee.TRANSFER_TOPIC, pad(sender), pad(recipient)]}


def _receipt(*logs, status=1):
    return {"status": status, "logs": list(logs)}


def a_batched_transfer_is_still_seen():
    # No direct USDC call anywhere in the calldata — only the log exists.
    facts = arming_fee.erc20_transfer_facts(
        _receipt(_log(USDC, WALLET, EXECUTOR, 750_000)),
        token=USDC, sender=WALLET, recipient=EXECUTOR)
    assert facts["amount"] == 750_000
    assert arming_fee.validate_arming_transfer(
        facts, wallet=WALLET, executor=EXECUTOR, usdc=USDC, required_wei=750_000
    ) == {"amount_wei": "750000", "asset": "USDC"}


def a_lookalike_token_cannot_pay_the_fee():
    # A batch may move several tokens; only the configured USDC counts.
    try:
        arming_fee.erc20_transfer_facts(
            _receipt(_log(OTHER_TOKEN, WALLET, EXECUTOR, 10 ** 18)),
            token=USDC, sender=WALLET, recipient=EXECUTOR)
    except ValueError as exc:
        assert "no tokens of the configured USDC" in str(exc)
    else:
        raise AssertionError("a non-USDC transfer was accepted as the arming fee")


def the_right_leg_is_picked_out_of_a_batch():
    facts = arming_fee.erc20_transfer_facts(
        _receipt(_log(USDC, WALLET, OTHER_TOKEN, 5),          # unrelated leg, listed first
                 _log(USDC, WALLET, EXECUTOR, 750_000)),
        token=USDC, sender=WALLET, recipient=EXECUTOR)
    assert facts["recipient"].lower() == EXECUTOR.lower()
    assert facts["amount"] == 750_000


def a_wrong_recipient_still_reports_the_real_reason():
    # Falls back to the first leg so the validator names the recipient, not a generic miss.
    facts = arming_fee.erc20_transfer_facts(
        _receipt(_log(USDC, WALLET, OTHER_TOKEN, 750_000)),
        token=USDC, sender=WALLET, recipient=EXECUTOR)
    try:
        arming_fee.validate_arming_transfer(
            facts, wallet=WALLET, executor=EXECUTOR, usdc=USDC, required_wei=750_000)
    except ValueError as exc:
        assert "recipient is not the configured executor wallet" in str(exc)
    else:
        raise AssertionError("a fee paid to the wrong address was accepted")


def test_arming_fee_7702():
    a_batched_transfer_is_still_seen()
    a_lookalike_token_cannot_pay_the_fee()
    the_right_leg_is_picked_out_of_a_batch()
    a_wrong_recipient_still_reports_the_real_reason()


if __name__ == "__main__":
    test_arming_fee_7702()
    print("ok")
