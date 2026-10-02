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
from app.deps.clients import get_executor_client
from app.repository.session import get_db
from app.repository.models import ApiKey, UsageEvent, IdempotencyKey, TxBinding



def _mock_executor(status_code=200, resp_payload=None):
    from app.adapters.executor import ExecutorClient

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.startswith("/internal/relay-submissions/") and path.endswith("/prepare"):
            assert request.headers["X-API-TOKEN"] == "tok"
            prepared = json.loads(request.content)
            assert prepared["wallet"] == "0xaaa"
            assert prepared["payload"]["chain_id"] == 8453
            return httpx.Response(201, json={"status": "leased"})
        if path == "/relayWithdraw":
            payload = json.loads(request.content)
            assert payload["chain_id"] == 8453
            assert payload["asset"] == "USDC"
            assert payload["recipient"] == "0xrec"
            assert "proof" in payload
            assert payload["proof"]["aspRoot"] == "0xasp"
            assert payload["proof"]["changeLabel"] == "0xlabel"
            return httpx.Response(status_code, json=resp_payload or {
                "status": "success",
                "tx_hash": "0xhash_withdraw_123"
            })
        return httpx.Response(404)

    return ExecutorClient(base_url="http://exec:5005", api_token="tok", transport=httpx.MockTransport(handler))


def _stash_key(key, *, sandbox=False):
    def _dep(request: Request):
        request.state.api_key_id = key.id
        request.state.sandbox = sandbox
        return key
    return _dep


def _app(monkeypatch, db, executor, wallet="0xaaa", *, sandbox=False):
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)

    fake = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")
    db.add(fake)
    db.commit()

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = _stash_key(fake, sandbox=sandbox)
    app.dependency_overrides[verify_wallet_sig] = lambda: wallet
    app.dependency_overrides[verify_wallet_intent_or_sandbox] = lambda: wallet
    app.dependency_overrides[get_executor_client] = lambda: executor
    app.dependency_overrides[get_db] = lambda: db
    return app


@pytest.mark.asyncio
async def test_create_withdrawal_success(monkeypatch, db_session):
    exec_mock = _mock_executor(status_code=200)
    # Mock screen_address to pass
    monkeypatch.setattr("app.services.sanctions.screen_address", lambda w, c: None)
    app = _app(monkeypatch, db_session, exec_mock)

    payload = {
        "chain_id": 8453,
        "asset": "USDC",
        "recipient": "0xrec",
        "amount": "1000000",
        "proof": {
            "stateRoot": "0xroot",
            "aspRoot": "0xasp",
            "nullifierHashes": ["0xnull1"],
            "changeCommitment": "0xchange",
            "changeLabel": "0xlabel",
            "pA": ["1", "2"],
            "pB": [["1", "2"], ["3", "4"]],
            "pC": ["1", "2"]
        }
    }

    headers = {
        "Authorization": "Bearer sk_test_x",
        "X-Wallet-Address": "0xaaa",
        "Idempotency-Key": "withdraw-idem-1"
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r1 = await c.post("/v1/withdrawals", headers=headers, json=payload)
        assert r1.status_code == 200, f"Unexpected response: {r1.json()}"
        body1 = r1.json()
        assert body1["status"] == "submitted"
        assert body1["tx_hash"] == "0xhash_withdraw_123"

        # Idempotency check
        r2 = await c.post("/v1/withdrawals", headers=headers, json=payload)
        assert r2.status_code == 200
        assert r1.json() == r2.json()

    # Ensure NO usage event was created during creation
    events = db_session.query(UsageEvent).all()
    assert len(events) == 0


@pytest.mark.asyncio
async def test_create_withdrawal_sanctioned(monkeypatch, db_session):
    from app.errors import Sanctioned
    def _mock_screen(w, c):
        if w == "0xrec":
            raise Sanctioned("Recipient is sanctioned.")
    monkeypatch.setattr("app.services.sanctions.screen_address", _mock_screen)

    app = _app(monkeypatch, db_session, _mock_executor(status_code=200))

    payload = {
        "chain_id": 8453,
        "asset": "USDC",
        "recipient": "0xrec",
        "amount": "1000000",
        "proof": {
            "stateRoot": "0xroot",
            "aspRoot": "0xasp",
            "nullifierHashes": ["0xnull1"],
            "changeCommitment": "0xchange",
            "changeLabel": "0xlabel",
            "pA": ["1", "2"],
            "pB": [["1", "2"], ["3", "4"]],
            "pC": ["1", "2"]
        }
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/withdrawals",
                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa", "Idempotency-Key": "no-leak"},
                         json=payload)
    assert r.status_code == 451
    assert r.json()["error_code"] == "sanctioned"


@pytest.mark.asyncio
async def test_confirm_withdrawal_success(monkeypatch, db_session):
    # Mock Web3 to return receipt on chain_id=11155111
    mock_w3 = MagicMock()
    mock_w3.eth.get_transaction_receipt.return_value = {"status": 1, "blockNumber": 100}
    mock_w3.eth.block_number = 105

    class MockWeb3:
        def __init__(self, *args, **kwargs):
            pass
        eth = mock_w3.eth
        HTTPProvider = MagicMock()

    monkeypatch.setattr("app.services.confirmations.Web3", MockWeb3)
    monkeypatch.setattr("app.routers.withdrawals.Web3", MockWeb3)
    monkeypatch.setattr("app.services.sanctions.screen_address", lambda w, c: None)

    app = _app(monkeypatch, db_session, _mock_executor(status_code=200))

    db_session.add(TxBinding(
        tx_hash="0xhash", wallet="0xaaa", api_key_id="k1", chain_id=11155111, kind="withdrawal",
    ))
    db_session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/withdrawals/0xhash/confirmation",

                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"},
                         json={"tx_hash": "0xhash"})
    assert r.status_code == 200
    assert r.json()["status"] == "confirmed"

    # Verify usage event was created
    events = db_session.query(UsageEvent).all()
    assert len(events) == 1
    assert events[0].event_type == "withdrawal"
    assert events[0].tx_hash == "0xhash"


@pytest.mark.asyncio
async def test_confirm_withdrawal_insufficient_confirmations(monkeypatch, db_session):
    # Mock Web3 to return block_number that is too low
    mock_w3 = MagicMock()
    mock_w3.eth.get_transaction_receipt.return_value = {"status": 1, "blockNumber": 100}
    mock_w3.eth.block_number = 101

    class MockWeb3:
        def __init__(self, *args, **kwargs):
            pass
        eth = mock_w3.eth
        HTTPProvider = MagicMock()

    monkeypatch.setattr("app.services.confirmations.Web3", MockWeb3)
    monkeypatch.setattr("app.routers.withdrawals.Web3", MockWeb3)
    monkeypatch.setattr("app.services.sanctions.screen_address", lambda w, c: None)

    app = _app(monkeypatch, db_session, _mock_executor(status_code=200))

    db_session.add(TxBinding(
        tx_hash="0xhash", wallet="0xaaa", api_key_id="k1", chain_id=11155111, kind="withdrawal",
    ))
    db_session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/withdrawals/0xhash/confirmation",
                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"},
                         json={"tx_hash": "0xhash"})

    assert r.status_code == 409
    assert r.json()["error_code"] == "conflict"


@pytest.mark.asyncio
async def test_sandbox_confirmation_never_calls_rpc_or_sanctions(monkeypatch, db_session):
    monkeypatch.setattr(
        "app.services.confirmations.find_tx_chain_and_receipt",
        lambda *_: (_ for _ in ()).throw(AssertionError("sandbox must not call RPC")),
    )
    monkeypatch.setattr(
        "app.services.sanctions.screen_address",
        lambda *_: (_ for _ in ()).throw(AssertionError("sandbox must not screen")),
    )
    app = _app(monkeypatch, db_session, _mock_executor(), sandbox=True)
    db_session.add(TxBinding(
        tx_hash="0xsandbox", wallet="0xaaa", api_key_id="k1", chain_id=8453, kind="withdrawal"
    ))
    db_session.commit()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        response = await client.post(
            "/v1/withdrawals/sandbox/confirmation",
            headers={"Authorization": "Bearer sk_test_x"},
            json={"tx_hash": "0xsandbox"},
        )
    assert response.status_code == 200
    assert response.json()["status"] == "confirmed"


@pytest.mark.asyncio
async def test_create_response_does_not_leak_internal_binding(monkeypatch, db_session):
    # The api_key_id / wallet binding is internal state (a TxBinding row), NOT part of the response.
    monkeypatch.setattr("app.services.sanctions.screen_address", lambda w, c: None)
    app = _app(monkeypatch, db_session, _mock_executor(status_code=200))

    payload = {
        "chain_id": 8453, "asset": "USDC", "recipient": "0xrec", "amount": "1000000",
        "proof": {"stateRoot": "0xroot", "aspRoot": "0xasp", "nullifierHashes": ["0xnull1"],
                  "changeCommitment": "0xchange", "changeLabel": "0xlabel",
                  "pA": ["1", "2"], "pB": [["1", "2"], ["3", "4"]], "pC": ["1", "2"]},
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/withdrawals",
                         headers={
                             "Authorization": "Bearer sk_test_x",
                             "X-Wallet-Address": "0xaaa",
                             "Idempotency-Key": "response-no-leak",
                         },
                         json=payload)
    assert r.status_code == 200
    body = r.json()
    assert "_api_key_id" not in body and "_wallet" not in body   # internal ids never leak
    assert set(body.keys()) == {"status", "tx_hash"}
    # the binding IS recorded internally, indexed by tx_hash
    tx_hash = body["tx_hash"]
    assert db_session.query(TxBinding).filter(TxBinding.tx_hash == tx_hash).count() == 1


@pytest.mark.asyncio
async def test_confirm_other_wallets_tx_is_404(monkeypatch, db_session):
    # BOLA: a tx bound to wallet B cannot be confirmed by wallet A -> 404 (never confirm existence).
    mock_w3 = MagicMock()
    mock_w3.eth.get_transaction_receipt.return_value = {"status": 1, "blockNumber": 100}
    mock_w3.eth.block_number = 105

    class MockWeb3:
        def __init__(self, *args, **kwargs):
            pass
        eth = mock_w3.eth
        HTTPProvider = MagicMock()

    monkeypatch.setattr("app.services.confirmations.Web3", MockWeb3)
    monkeypatch.setattr("app.routers.withdrawals.Web3", MockWeb3)
    monkeypatch.setattr("app.services.sanctions.screen_address", lambda w, c: None)

    app = _app(monkeypatch, db_session, _mock_executor(status_code=200), wallet="0xaaa")
    # tx bound to a DIFFERENT wallet (0xbbb)
    db_session.add(TxBinding(tx_hash="0xhash", wallet="0xbbb", api_key_id="k1",
                             chain_id=11155111, kind="withdrawal"))
    db_session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/withdrawals/0xhash/confirmation",
                         headers={"Authorization": "Bearer sk_test_x", "X-Wallet-Address": "0xaaa"},
                         json={"tx_hash": "0xhash"})
    assert r.status_code == 404
    assert r.json()["error_code"] == "not_found"
