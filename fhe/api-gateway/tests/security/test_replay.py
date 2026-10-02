"""Replay protection — a captured wallet signature can be used at most once within its window."""
import time

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct

from app.deps.wallet_sig import FRESHNESS_WINDOW_SECONDS, check_wallet_sig
from app.errors import ReplayedRequest


def _sign(acct, chain_id, ts):
    msg = f"Siphon API v1:{chain_id}:{ts}"
    return "0x" + Account.sign_message(encode_defunct(text=msg), acct.key).signature.hex().removeprefix("0x")


def test_captured_signature_cannot_be_replayed(fake_redis):
    acct = Account.create()
    ts = str(int(time.time()))
    sig = _sign(acct, 8453, ts)
    # attacker captures a valid (wallet, ts, sig); the first legitimate use consumes the nonce
    assert check_wallet_sig(fake_redis, wallet=acct.address, signature=sig, timestamp=ts, chain_id=8453)
    # every subsequent replay within the window is rejected
    for _ in range(3):
        with pytest.raises(ReplayedRequest):
            check_wallet_sig(fake_redis, wallet=acct.address, signature=sig, timestamp=ts, chain_id=8453)


def test_nonce_ttl_matches_freshness_window(fake_redis):
    acct = Account.create()
    ts = str(int(time.time()))
    sig = _sign(acct, 8453, ts)
    check_wallet_sig(fake_redis, wallet=acct.address, signature=sig, timestamp=ts, chain_id=8453)
    # the nonce entry expires with the freshness window (no unbounded growth)
    key = f"walletnonce:{acct.address.lower()}:{ts}::{sig}"
    ttl = fake_redis.ttl(key)
    assert 0 < ttl <= FRESHNESS_WINDOW_SECONDS


def test_nonce_is_binding_not_advisory(fake_redis):
    """A signature that did not commit to a nonce must be rejected when X-Nonce is supplied.

    The old code fell back to the nonce-less message here, so any caller could staple an arbitrary
    nonce onto a captured signature and have it accepted — the nonce constrained nothing.
    """
    from app.errors import Unauthorized

    acct = Account.create()
    ts = str(int(time.time()))
    sig = _sign(acct, 8453, ts)  # signed WITHOUT a nonce

    with pytest.raises(Unauthorized):
        check_wallet_sig(
            fake_redis, wallet=acct.address, signature=sig, timestamp=ts,
            chain_id=8453, nonce="attacker-supplied",
        )


def test_nonce_bound_signature_is_accepted(fake_redis):
    acct = Account.create()
    ts = str(int(time.time()))
    nonce = "req-abc-123"
    msg = f"Siphon API v1:8453:{ts}:{nonce}"
    sig = "0x" + Account.sign_message(encode_defunct(text=msg), acct.key).signature.hex().removeprefix("0x")

    assert check_wallet_sig(
        fake_redis, wallet=acct.address, signature=sig, timestamp=ts, chain_id=8453, nonce=nonce,
    ) == acct.address.lower()

    # and it is still single-use
    with pytest.raises(ReplayedRequest):
        check_wallet_sig(
            fake_redis, wallet=acct.address, signature=sig, timestamp=ts, chain_id=8453, nonce=nonce,
        )
