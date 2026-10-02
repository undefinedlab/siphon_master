"""The executor independently verifies the exact public strategy intent."""
import json
import time

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from flask import Flask, jsonify

from wallet_auth import _strategy_intent_message, verify_strategy_sig

GATEWAY_TOKEN = "gateway-shared-secret"


@pytest.fixture(autouse=True)
def _gateway_token(monkeypatch):
    monkeypatch.setenv("API_TOKEN", GATEWAY_TOKEN)


def _app():
    app = Flask(__name__)

    @app.post("/createStrategy")
    @verify_strategy_sig
    def create_strategy():
        return jsonify({"ok": True})

    return app


def _signed(client_body):
    signer = Account.create()
    timestamp = str(int(time.time()))
    nonce = "strategy-1"
    signature = Account.sign_message(
        encode_defunct(text=_strategy_intent_message(client_body, timestamp, nonce)),
        signer.key,
    ).signature.hex()
    executor_body = {
        **client_body,
        "user_id": signer.address,
        "billing_ref": "gateway-authenticated-ref",
    }
    headers = {
        "X-Wallet-Address": signer.address,
        "X-Signature": signature,
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Siphon-Gateway-Token": GATEWAY_TOKEN,
    }
    return executor_body, headers


def test_executor_accepts_gateway_metadata_without_leaving_client_fields_unsigned():
    executor_body, headers = _signed(
        {"from_chain": 8453, "strategy_type": "LIMIT_SELL", "amount": "1"}
    )

    with _app().test_client() as client:
        accepted = client.post("/createStrategy", json=executor_body, headers=headers)
        altered = client.post(
            "/createStrategy",
            data=json.dumps({**executor_body, "amount": "2"}),
            content_type="application/json",
            headers=headers,
        )

    assert accepted.status_code == 200
    assert altered.status_code == 401


def test_gateway_traffic_without_the_intent_signature_is_rejected():
    """Attestation present but no signed intent — the body binding must not be skippable."""
    executor_body, headers = _signed({"from_chain": 8453, "amount": "1"})
    headers.pop("X-Signature")

    with _app().test_client() as client:
        res = client.post("/createStrategy", json=executor_body, headers=headers)

    assert res.status_code == 401


def test_direct_browser_submission_falls_through_to_the_write_challenge():
    """The dapp posts /createStrategy itself and signs the write challenge, never the v2 intent.

    Requiring both 401'd every browser arm. Without the gateway attestation this decorator must
    defer — `verify_wallet_write` sits directly beneath it and still demands a wallet signature.
    """
    with _app().test_client() as client:
        res = client.post(
            "/createStrategy",
            json={"from_chain": 11155111, "strategy_type": "LIMIT_SELL", "amount": "1"},
            headers={
                "X-Wallet-Address": Account.create().address,
                "X-Write-Signature": "0xdeadbeef",
                "X-Write-Nonce": "challenge-nonce",
            },
        )

    assert res.status_code == 200
