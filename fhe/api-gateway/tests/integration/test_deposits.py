import json
import fakeredis
import httpx
import pytest
from httpx import ASGITransport, AsyncClient
from datetime import datetime, timezone
from fastapi import Request
from unittest.mock import MagicMock

from app.main import create_app
from app.deps.api_key import verify_api_key
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox, verify_wallet_sig
from app.repository.session import get_db
from app.repository.models import ApiKey, UsageEvent
from app.repository.note_db import NoteRow


class _FakeNoteRow:
    def __init__(self, id, wallet, commitment, nullifier_hash, chain_id, asset, spent, ciphertext="ct", iv="iv"):
        self.id = id
        self.wallet = wallet
        self.commitment = commitment
        self.nullifier_hash = nullifier_hash
        self.chain_id = chain_id
        self.asset = asset
        self.spent = spent
        self.ciphertext = ciphertext
        self.iv = iv


def _stash_key(key):
    def _dep(request: Request):
        request.state.api_key_id = key.id
        return key
    return _dep


def _app(monkeypatch, db, wallet="0xaaa"):
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)

    fake = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")
    db.add(fake)
    db.commit()

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = _stash_key(fake)
    app.dependency_overrides[verify_wallet_sig] = lambda: wallet
    app.dependency_overrides[verify_wallet_intent_or_sandbox] = lambda: wallet
    app.dependency_overrides[get_db] = lambda: db
    return app


@pytest.mark.asyncio
async def test_create_deposit_success(monkeypatch, db_session):
    # Mock screen_address to pass
    monkeypatch.setattr("app.services.sanctions.screen_address", lambda wallet, chain_id: None)
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_11155111", "sepolia-hard-asp-v1")
    monkeypatch.setenv("EXIT_ONLY_VAULT_GENERATIONS", "base-legacy-2026-07,sepolia-soft-era")

    app = _app(monkeypatch, db_session)

    payload = {
        "chain_id": 11155111,
        "asset": "USDC",
        "amount": "10.0",
        "precommitment": "12345678"
    }


    headers = {
        "Authorization": "Bearer sk_test_x",
        "X-Wallet-Address": "0xaaa",
        "Idempotency-Key": "dep-idem-1"
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r1 = await c.post("/v1/deposits", headers=headers, json=payload)
        assert r1.status_code == 200, f"Unexpected response: {r1.json()}"
        body1 = r1.json()
        assert "calldata" in body1
        assert body1["deposit_id"] == "12345678"
        assert body1["vault_generation_id"] == "sepolia-hard-asp-v1"

        # Idempotency check
        r2 = await c.post("/v1/deposits", headers=headers, json=payload)
        assert r2.status_code == 200
        assert r1.json() == r2.json()


@pytest.mark.asyncio
async def test_create_deposit_sanctioned(monkeypatch, db_session):
    from app.errors import Sanctioned
    def _mock_screen(wallet, chain_id):
        raise Sanctioned("Address is sanctioned.")
    monkeypatch.setattr("app.services.sanctions.screen_address", _mock_screen)

    app = _app(monkeypatch, db_session)

    payload = {
        "chain_id": 8453,
        "asset": "USDC",
        "amount": "10.0",
        "precommitment": "12345678"
    }


    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/deposits",
                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"},
                         json=payload)
    assert r.status_code == 451
    assert r.json()["error_code"] == "sanctioned"


@pytest.mark.asyncio
async def test_confirm_deposit_success(monkeypatch, db_session):
    # Mock note DB fetch and session
    fake_note = _FakeNoteRow(
        id="n1",
        wallet="0xaaa",
        commitment="9999",
        nullifier_hash="8888",
        chain_id=11155111,
        asset="ETH",
        spent="pending"
    )

    class FakeSession:
        def __init__(self):
            self.committed = False
            self.closed = False
        def query(self, model):
            return self
        def filter(self, *args, **kwargs):
            return self
        def first(self):
            return fake_note
        def commit(self):
            self.committed = True
        def close(self):
            self.closed = True

    mock_session = FakeSession()
    monkeypatch.setattr("app.repository.note_db._note_session", lambda: mock_session)

    monkeypatch.setattr("app.services.sanctions.screen_address", lambda w, c: None)

    # Mock web3 RPC checks
    mock_w3 = MagicMock()
    mock_w3.eth.get_transaction_receipt.return_value = {"status": 1, "blockNumber": 100}
    mock_w3.eth.block_number = 105

    class MockWeb3:
        def __init__(self, *args, **kwargs):
            pass
        eth = mock_w3.eth
        HTTPProvider = MagicMock()

    monkeypatch.setattr("app.services.confirmations.Web3", MockWeb3)


    app = _app(monkeypatch, db_session)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/deposits/9999/confirmation",
                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"},
                         json={"tx_hash": "0xhash"})
    assert r.status_code == 200
    assert r.json()["status"] == "confirmed"
    assert fake_note.spent == "false"
    assert mock_session.committed is True
    assert mock_session.closed is True


@pytest.mark.asyncio
async def test_confirm_deposit_not_enough_confirmations(monkeypatch, db_session):
    fake_note = _FakeNoteRow(
        id="n1",
        wallet="0xaaa",
        commitment="9999",
        nullifier_hash="8888",
        chain_id=11155111,
        asset="ETH",
        spent="pending"
    )

    class FakeSession:
        def query(self, model): return self
        def filter(self, *args, **kwargs): return self
        def first(self): return fake_note
        def close(self): pass

    monkeypatch.setattr("app.repository.note_db._note_session", lambda: FakeSession())

    monkeypatch.setattr("app.services.sanctions.screen_address", lambda w, c: None)

    # Mock web3 RPC checks: block diff = 101 - 100 = 1, below threshold (2)
    mock_w3 = MagicMock()
    mock_w3.eth.get_transaction_receipt.return_value = {"status": 1, "blockNumber": 100}
    mock_w3.eth.block_number = 101

    class MockWeb3:
        def __init__(self, *args, **kwargs):
            pass
        eth = mock_w3.eth
        HTTPProvider = MagicMock()

    monkeypatch.setattr("app.services.confirmations.Web3", MockWeb3)


    app = _app(monkeypatch, db_session)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/deposits/9999/confirmation",
                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"},
                         json={"tx_hash": "0xhash"})
    assert r.status_code == 409
    assert r.json()["error_code"] == "conflict"


@pytest.mark.asyncio
async def test_confirm_deposit_unauthorized_bola(monkeypatch, db_session):
    # Note belongs to 0xbbb, authed wallet is 0xaaa
    fake_note = _FakeNoteRow(
        id="n1",
        wallet="0xbbb",
        commitment="9999",
        nullifier_hash="8888",
        chain_id=11155111,
        asset="ETH",
        spent="pending"
    )

    class FakeSession:
        def query(self, model): return self
        def filter(self, *args, **kwargs): return self
        def first(self): return fake_note
        def close(self): pass

    monkeypatch.setattr("app.repository.note_db._note_session", lambda: FakeSession())


    app = _app(monkeypatch, db_session, wallet="0xaaa")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/deposits/9999/confirmation",
                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"},
                         json={"tx_hash": "0xhash"})
    # Under BOLA, unauthorized note should return 404 Not Found to prevent leaking existence
    assert r.status_code == 404
