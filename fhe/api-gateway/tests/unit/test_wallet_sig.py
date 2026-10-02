"""Wallet-signature auth — 300s freshness window + Redis nonce cache (replay-safe).

Tests the pure core (check_wallet_sig) directly with fakeredis; the FastAPI dependency wraps it.
"""
import time

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct

from app.deps.wallet_sig import check_wallet_sig
from app.errors import ReplayedRequest, StaleSignature, Unauthorized


def _sign(acct, chain_id, ts):
    msg = f"Siphon API v1:{chain_id}:{ts}"
    return "0x" + Account.sign_message(encode_defunct(text=msg), acct.key).signature.hex().removeprefix("0x")


def test_valid_fresh_sig_returns_address(fake_redis):
    acct = Account.create()
    ts = str(int(time.time()))
    sig = _sign(acct, 8453, ts)
    got = check_wallet_sig(fake_redis, wallet=acct.address, signature=sig, timestamp=ts, chain_id=8453)
    assert got == acct.address.lower()


def test_wrong_wallet_is_unauthorized(fake_redis):
    acct = Account.create()
    other = Account.create()
    ts = str(int(time.time()))
    sig = _sign(acct, 8453, ts)
    with pytest.raises(Unauthorized):
        check_wallet_sig(fake_redis, wallet=other.address, signature=sig, timestamp=ts, chain_id=8453)


def test_stale_timestamp_rejected(fake_redis):
    acct = Account.create()
    ts = str(int(time.time()) - 400)  # 400s old > 300s window
    sig = _sign(acct, 8453, ts)
    with pytest.raises(StaleSignature):
        check_wallet_sig(fake_redis, wallet=acct.address, signature=sig, timestamp=ts, chain_id=8453)


def test_replay_within_window_rejected(fake_redis):
    acct = Account.create()
    ts = str(int(time.time()))
    sig = _sign(acct, 8453, ts)
    assert check_wallet_sig(fake_redis, wallet=acct.address, signature=sig, timestamp=ts, chain_id=8453)
    with pytest.raises(ReplayedRequest):
        check_wallet_sig(fake_redis, wallet=acct.address, signature=sig, timestamp=ts, chain_id=8453)


def test_distinct_client_nonces_same_second_ok(fake_redis):
    """Two calls in the same second succeed when each signs a unique X-Nonce."""
    acct = Account.create()
    ts = str(int(time.time()))
    chain_id = 8453
    for n in ("a1", "b2"):
        msg = f"Siphon API v1:{chain_id}:{ts}:{n}"
        sig = "0x" + Account.sign_message(encode_defunct(text=msg), acct.key).signature.hex().removeprefix("0x")
        got = check_wallet_sig(
            fake_redis,
            wallet=acct.address,
            signature=sig,
            timestamp=ts,
            chain_id=chain_id,
            nonce=n,
        )
        assert got == acct.address.lower()
