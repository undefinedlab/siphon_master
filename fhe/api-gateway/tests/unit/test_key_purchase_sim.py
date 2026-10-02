"""Simulated API-key purchase flows (no live RPC)."""
import pytest
from eth_abi import encode as abi_encode
from web3 import Web3

from app.errors import BadRequest, Conflict
from app.repository.models import ApiKey, UsageEvent
from app.services import key_purchase

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


def _topic_addr(addr: str) -> bytes:
    return bytes.fromhex(addr.lower().replace("0x", "").rjust(64, "0"))


def _fake_receipt(*, payer: str, collector: str, token: str, amount: int) -> dict:
    return {
        "status": 1,
        "blockNumber": 100,
        "logs": [
            {
                "address": token,
                "topics": [
                    bytes.fromhex(TRANSFER_TOPIC[2:]),
                    _topic_addr(payer),
                    _topic_addr(collector),
                ],
                "data": "0x" + abi_encode(["uint256"], [amount]).hex(),
            }
        ],
    }


def _patch_w3(monkeypatch, receipt: dict):
    class FakeEth:
        def get_transaction_receipt(self, _tx):
            return receipt

    class FakeW3:
        to_checksum_address = staticmethod(Web3.to_checksum_address)

        def __init__(self, *_a, **_k):
            self.eth = FakeEth()

        class HTTPProvider:  # noqa: N801 — mirror web3 API
            def __init__(self, url):
                self.url = url

    monkeypatch.setattr(key_purchase, "Web3", FakeW3)
    monkeypatch.setattr(key_purchase, "get_rpc_url", lambda _cid: "http://fake")
    monkeypatch.setattr(key_purchase, "is_confirmed", lambda _cid, _tx: True)


def test_purchase_mints_credits_and_lists(monkeypatch, db_session, fake_redis):
    payer = "0x1111111111111111111111111111111111111111"
    collector = key_purchase.collector_address()
    token = key_purchase.usdc_address(8453)
    amount = key_purchase.PACKS["starter"]["usdc_minor"]
    tx = "0x" + ("ab" * 32)
    _patch_w3(
        monkeypatch,
        _fake_receipt(payer=payer, collector=collector, token=token, amount=amount),
    )

    res = key_purchase.purchase_key(
        db_session,
        wallet=payer,
        chain_id=8453,
        pack_id="starter",
        tx_hash=tx,
        request_id="sim-1",
        test=True,
    )
    db_session.commit()

    assert res["api_key"].startswith("sk_test_")
    assert res["balance_minor"] == amount
    row = db_session.query(ApiKey).filter_by(id=res["api_key_id"]).one()
    assert row.integrator_id == payer.lower()
    assert row.balance_minor == amount
    assert db_session.query(UsageEvent).filter_by(event_type="key_purchase").count() == 1

    listed = key_purchase.list_keys_for_wallet(db_session, payer)
    assert len(listed) == 1
    assert listed[0]["api_key_id"] == res["api_key_id"]


def test_purchase_rejects_replay(monkeypatch, db_session, fake_redis):
    payer = "0x2222222222222222222222222222222222222222"
    collector = key_purchase.collector_address()
    token = key_purchase.usdc_address(8453)
    amount = key_purchase.PACKS["growth"]["usdc_minor"]
    tx = "0x" + ("cd" * 32)
    _patch_w3(
        monkeypatch,
        _fake_receipt(payer=payer, collector=collector, token=token, amount=amount),
    )

    key_purchase.purchase_key(
        db_session,
        wallet=payer,
        chain_id=8453,
        pack_id="growth",
        tx_hash=tx,
        request_id="sim-a",
        test=True,
    )
    db_session.commit()

    with pytest.raises(Conflict):
        key_purchase.purchase_key(
            db_session,
            wallet=payer,
            chain_id=8453,
            pack_id="growth",
            tx_hash=tx,
            request_id="sim-b",
            test=True,
        )


def test_verify_rejects_wrong_amount(monkeypatch):
    payer = "0x3333333333333333333333333333333333333333"
    collector = key_purchase.collector_address()
    token = key_purchase.usdc_address(8453)
    amount = key_purchase.PACKS["starter"]["usdc_minor"]
    _patch_w3(
        monkeypatch,
        _fake_receipt(payer=payer, collector=collector, token=token, amount=amount - 1),
    )

    with pytest.raises(BadRequest):
        key_purchase.verify_usdc_payment(
            chain_id=8453,
            tx_hash="0x" + ("ef" * 32),
            payer=payer,
            expected_amount_minor=amount,
        )


def test_purchase_rejects_an_unconfirmed_payment(monkeypatch, db_session, fake_redis):
    payer = "0x4444444444444444444444444444444444444444"
    collector = key_purchase.collector_address()
    token = key_purchase.usdc_address(8453)
    amount = key_purchase.PACKS["starter"]["usdc_minor"]
    _patch_w3(
        monkeypatch,
        _fake_receipt(payer=payer, collector=collector, token=token, amount=amount),
    )
    monkeypatch.setattr(key_purchase, "is_confirmed", lambda _cid, _tx: False)

    with pytest.raises(BadRequest, match="not yet confirmed"):
        key_purchase.purchase_key(
            db_session,
            wallet=payer,
            chain_id=8453,
            pack_id="starter",
            tx_hash="0x" + ("12" * 32),
            request_id="sim-unconfirmed",
            test=True,
        )
