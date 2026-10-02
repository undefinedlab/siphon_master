"""Wallet intent authorization binds authority to one exact API mutation."""
import time

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct

from app.deps.wallet_sig import canonical_intent_message, check_wallet_intent
from app.errors import ReplayedRequest, Unauthorized
from wallet_auth import _strategy_intent_message


def _sign(account, *, body: dict, nonce: str = "request-1", path: str = "/v1/payouts") -> str:
    message = canonical_intent_message(
        chain_id=8453,
        timestamp=str(int(time.time())),
        nonce=nonce,
        method="POST",
        path=path,
        body=body,
    )
    signature = Account.sign_message(encode_defunct(text=message), account.key).signature.hex()
    return "0x" + signature.removeprefix("0x")


def test_intent_signature_authorizes_only_the_exact_body(fake_redis):
    account = Account.create()
    timestamp = str(int(time.time()))
    body = {"chain_id": 8453, "asset": "USDC", "amount_minor": 10, "recipient": "0xabc"}
    message = canonical_intent_message(
        chain_id=8453,
        timestamp=timestamp,
        nonce="request-1",
        method="POST",
        path="/v1/payouts",
        body=body,
    )
    signature = "0x" + Account.sign_message(
        encode_defunct(text=message), account.key
    ).signature.hex().removeprefix("0x")

    changed = dict(body, amount_minor=11)
    with pytest.raises(Unauthorized):
        check_wallet_intent(
            fake_redis,
            wallet=account.address,
            signature=signature,
            timestamp=timestamp,
            nonce="request-1",
            chain_id=8453,
            method="POST",
            path="/v1/payouts",
            body=changed,
        )


def test_intent_signature_authorizes_only_the_exact_route(fake_redis):
    account = Account.create()
    timestamp = str(int(time.time()))
    body = {"chain_id": 8453}
    message = canonical_intent_message(
        chain_id=8453,
        timestamp=timestamp,
        nonce="request-2",
        method="POST",
        path="/v1/payouts",
        body=body,
    )
    signature = "0x" + Account.sign_message(
        encode_defunct(text=message), account.key
    ).signature.hex().removeprefix("0x")

    with pytest.raises(Unauthorized):
        check_wallet_intent(
            fake_redis,
            wallet=account.address,
            signature=signature,
            timestamp=timestamp,
            nonce="request-2",
            chain_id=8453,
            method="POST",
            path="/v1/accounts",
            body=body,
        )


def test_intent_nonce_is_required_and_single_use(fake_redis):
    account = Account.create()
    timestamp = str(int(time.time()))
    body = {"chain_id": 8453}
    message = canonical_intent_message(
        chain_id=8453,
        timestamp=timestamp,
        nonce="request-3",
        method="POST",
        path="/v1/payouts",
        body=body,
    )
    signature = "0x" + Account.sign_message(
        encode_defunct(text=message), account.key
    ).signature.hex().removeprefix("0x")

    kwargs = dict(
        wallet=account.address,
        signature=signature,
        timestamp=timestamp,
        nonce="request-3",
        chain_id=8453,
        method="POST",
        path="/v1/payouts",
        body=body,
    )
    assert check_wallet_intent(fake_redis, **kwargs) == account.address.lower()
    with pytest.raises(ReplayedRequest):
        check_wallet_intent(fake_redis, **kwargs)

    with pytest.raises(Unauthorized):
        check_wallet_intent(fake_redis, **dict(kwargs, nonce=""))


def test_canonical_message_is_stable_across_json_key_order():
    common = dict(
        chain_id=8453,
        timestamp="1700000000",
        nonce="stable",
        method="POST",
        path="/v1/payouts",
    )
    left = canonical_intent_message(body={"asset": "USDC", "chain_id": 8453}, **common)
    right = canonical_intent_message(body={"chain_id": 8453, "asset": "USDC"}, **common)
    assert left == right


def test_gateway_and_executor_reconstruct_identical_strategy_intent_from_from_chain():
    body = {"from_chain": 8453, "strategy_type": "LIMIT_SELL", "amount": "1"}
    gateway = canonical_intent_message(
        chain_id=body["from_chain"],
        timestamp="1700000000",
        nonce="strategy-1",
        method="POST",
        path="/v1/strategies",
        body=body,
    )
    executor = _strategy_intent_message(
        {**body, "user_id": "0xabc", "billing_ref": "signed-by-gateway"},
        "1700000000",
        "strategy-1",
    )
    assert gateway == executor
