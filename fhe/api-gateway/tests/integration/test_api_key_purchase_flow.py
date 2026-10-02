"""Public HTTP journey for self-serve API key acquisition and use."""
import hashlib
import json
import time

import fakeredis
import pytest
from eth_abi import encode as abi_encode
from eth_account import Account
from eth_account.messages import encode_defunct
from httpx import ASGITransport, AsyncClient
from web3 import Web3 as RealWeb3

from app.deps.wallet_sig import canonical_intent_message
from app.main import create_app
from app.repository.models import IdempotencyKey
from app.repository.session import get_db
from app.services import key_purchase


def _signature(account, message: str) -> str:
    raw = Account.sign_message(encode_defunct(text=message), account.key).signature.hex()
    return "0x" + raw.removeprefix("0x")


@pytest.mark.asyncio
async def test_wallet_purchase_list_and_bearer_verify(monkeypatch, db_session):
    redis = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: redis)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: redis)

    account = Account.create()
    chain_id = 8453
    tx_hash = "0x" + ("ab" * 32)
    delivery_key = "0x" + ("42" * 32)
    delivery_key_hash = hashlib.sha256(bytes.fromhex(delivery_key[2:])).hexdigest()
    body = {
        "chain_id": chain_id,
        "pack_id": "starter",
        "tx_hash": tx_hash,
        "delivery_key_sha256": delivery_key_hash,
    }
    timestamp = str(int(time.time()))
    nonce = "purchase-flow-1"
    purchase_message = canonical_intent_message(
        chain_id=chain_id,
        timestamp=timestamp,
        nonce=nonce,
        method="POST",
        path="/v1/keys/purchase",
        body=body,
    )

    collector = key_purchase.collector_address()
    token = key_purchase.usdc_address(chain_id)
    amount = key_purchase.PACKS["starter"]["usdc_minor"]
    receipt_reads = []
    confirmation_checks = []
    transfer_topic = bytes.fromhex(key_purchase.TRANSFER_TOPIC.removeprefix("0x"))

    def topic_address(address: str) -> bytes:
        return bytes.fromhex(address.removeprefix("0x").rjust(64, "0"))

    receipt = {
        "status": 1,
        "blockNumber": 100,
        "logs": [
            {
                "address": token,
                "topics": [
                    transfer_topic,
                    topic_address(account.address),
                    topic_address(collector),
                ],
                "data": "0x" + abi_encode(["uint256"], [amount]).hex(),
            }
        ],
    }

    class FakeEth:
        def get_transaction_receipt(self, requested_hash):
            receipt_reads.append(requested_hash)
            return receipt

    class FakeWeb3:
        to_checksum_address = staticmethod(RealWeb3.to_checksum_address)

        class HTTPProvider:  # noqa: N801 - mirrors web3's public API
            def __init__(self, url):
                self.url = url

        def __init__(self, _provider):
            self.eth = FakeEth()

    monkeypatch.setattr(key_purchase, "Web3", FakeWeb3)
    monkeypatch.setattr(key_purchase, "get_rpc_url", lambda _chain_id: "http://fake-rpc")
    monkeypatch.setattr(
        key_purchase,
        "is_confirmed",
        lambda requested_chain, requested_hash: confirmation_checks.append(
            (requested_chain, requested_hash)
        )
        or True,
    )

    app = create_app(start_reconciler=False)
    app.dependency_overrides[get_db] = lambda: db_session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        packs_response = await client.get("/v1/keys/packs")
        assert packs_response.status_code == 200
        assert any(pack["id"] == "starter" for pack in packs_response.json()["packs"])

        purchase_response = await client.post(
            "/v1/keys/purchase",
            json=body,
            headers={
                "X-Wallet-Address": account.address,
                "X-Signature": _signature(account, purchase_message),
                "X-Timestamp": timestamp,
                "X-Nonce": nonce,
                "X-Delivery-Key": delivery_key,
                "Idempotency-Key": "api-key-purchase-flow-1",
            },
        )
        assert purchase_response.status_code == 200, purchase_response.text
        purchase = purchase_response.json()
        plaintext_key = purchase["api_key"]
        assert plaintext_key.startswith("sk_test_")
        assert purchase["balance_minor"] == 5_000_000
        assert receipt_reads == [tx_hash]
        assert confirmation_checks == [(chain_id, tx_hash)]

        stored_idempotency = db_session.query(IdempotencyKey).one()
        assert plaintext_key not in json.dumps(stored_idempotency.response_body)
        assert delivery_key not in json.dumps(stored_idempotency.response_body)
        assert stored_idempotency.response_body["api_key_envelope"]

        retry_timestamp = str(int(time.time()))
        retry_message = canonical_intent_message(
            chain_id=chain_id,
            timestamp=retry_timestamp,
            nonce="purchase-flow-2",
            method="POST",
            path="/v1/keys/purchase",
            body=body,
        )
        retry_response = await client.post(
            "/v1/keys/purchase",
            json=body,
            headers={
                "X-Wallet-Address": account.address,
                "X-Signature": _signature(account, retry_message),
                "X-Timestamp": retry_timestamp,
                "X-Nonce": "purchase-flow-2",
                "X-Delivery-Key": delivery_key,
                "Idempotency-Key": "api-key-purchase-flow-1",
            },
        )
        assert retry_response.status_code == 200, retry_response.text
        assert retry_response.json()["api_key"] == plaintext_key
        assert receipt_reads == [tx_hash]
        assert confirmation_checks == [(chain_id, tx_hash)]

        list_timestamp = str(int(time.time()))
        list_nonce = "list-flow-1"
        list_message = f"Siphon API v1:{chain_id}:{list_timestamp}:{list_nonce}"
        list_response = await client.get(
            f"/v1/keys?chain_id={chain_id}",
            headers={
                "X-Wallet-Address": account.address,
                "X-Signature": _signature(account, list_message),
                "X-Timestamp": list_timestamp,
                "X-Nonce": list_nonce,
            },
        )
        assert list_response.status_code == 200, list_response.text
        listed = list_response.json()["keys"]
        assert [item["api_key_id"] for item in listed] == [purchase["api_key_id"]]
        assert "api_key" not in listed[0]

        verify_response = await client.get(
            "/v1/keys/verify",
            headers={"Authorization": f"Bearer {plaintext_key}"},
        )
        assert verify_response.status_code == 200, verify_response.text
        assert verify_response.json() == {
            "ok": True,
            "api_key_id": purchase["api_key_id"],
            "plan": "starter",
            "status": "active",
            "integrator_id": account.address.lower(),
        }
