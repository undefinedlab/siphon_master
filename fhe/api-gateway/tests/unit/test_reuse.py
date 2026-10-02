"""The reuse shim imports the executor's auth/sanctions helpers — it must NOT reimplement them.

recover_wallet wraps eth_account exactly as the executor's wallet_auth does; validate_recipient /
check_sanctions are re-exported straight from the executor's address_validator (D1: reuse, never
rebuild — reimplementing auth is what reintroduces bugs).
"""
from eth_account import Account
from eth_account.messages import encode_defunct

from app import reuse


def test_recover_wallet_roundtrip():
    acct = Account.create()
    msg = "Siphon API v1:8453:1700000000"
    sig = Account.sign_message(encode_defunct(text=msg), acct.key).signature.hex()
    assert reuse.recover_wallet(msg, sig) == acct.address.lower()


def test_recover_wallet_rejects_garbage():
    assert reuse.recover_wallet("Siphon API v1:8453:1700000000", "0xdeadbeef") is None


def test_validate_recipient_is_the_executor_function():
    # Sepolia (testnet) is not sanctions-screened; a well-formed address validates.
    ok, _ = reuse.validate_recipient("0x" + "0" * 40, "11155111")
    assert ok is True
    # malformed address is rejected
    bad, msg = reuse.validate_recipient("not-an-address", "11155111")
    assert bad is False and msg
