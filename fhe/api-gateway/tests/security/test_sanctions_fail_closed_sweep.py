"""§12 sweep — sanctions fail-CLOSED on every write path.

A screening failure (a real hit OR an unreachable oracle — `screen_address` raises `Sanctioned` for
both) must BLOCK the tx with 451, never let it through. This asserts the wired HTTP behavior across
all three fund-moving create routes in one place (the v1 exit gate), not the primitive in isolation.
"""
import fakeredis
import httpx
import pytest
from fastapi import Request
from httpx import ASGITransport, AsyncClient

from app.main import create_app
from app.deps.api_key import verify_api_key
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox, verify_wallet_sig
from app.deps.clients import get_executor_client
from app.repository.session import get_db
from app.repository.models import ApiKey
from app.errors import Sanctioned


def _mock_executor():
    """An executor that would 'succeed' — so a 451 can only come from the gateway blocking. If
    sanctions ever fail-OPEN, this executor returns success and the test catches it."""
    from app.adapters.executor import ExecutorClient

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "success", "tx_hash": "0xSHOULD_NOT_REACH"})

    return ExecutorClient(base_url="http://exec:5005", api_token="tok",
                          transport=httpx.MockTransport(handler))


def _stash_key(key):
    def _dep(request: Request):
        request.state.api_key_id = key.id
        return key
    return _dep


def _app(monkeypatch, db):
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)

    fake = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")
    db.add(fake)
    db.commit()

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = _stash_key(fake)
    app.dependency_overrides[verify_wallet_sig] = lambda: "0xaaa"
    app.dependency_overrides[verify_wallet_intent_or_sandbox] = lambda: "0xaaa"
    app.dependency_overrides[get_executor_client] = lambda: _mock_executor()
    app.dependency_overrides[get_db] = lambda: db
    return app


_WITHDRAW_PROOF = {
    "stateRoot": "0xroot", "aspRoot": "0xasp", "nullifierHashes": ["0xnull1"],
    "changeCommitment": "0xchange", "changeLabel": "0xlabel",
    "pA": ["1", "2"], "pB": [["1", "2"], ["3", "4"]], "pC": ["1", "2"],
}
_MERGE_PROOF = {
    "stateRoot": "0xroot", "aspRoot": "0xasp", "nullifierHashes": ["0xn1", "0xn2"],
    "mergedCommitment": "0xmerged", "mergedLabel": "0xlabel",
    "pA": ["1", "2"], "pB": [["1", "2"], ["3", "4"]], "pC": ["1", "2"],
}

WRITE_ROUTES = [
    ("/v1/deposits",
     {"chain_id": 8453, "asset": "USDC", "amount": "1000000", "precommitment": "0x1234"}),
    ("/v1/withdrawals",
     {"chain_id": 8453, "asset": "USDC", "recipient": "0xrec", "amount": "1000000",
      "proof": _WITHDRAW_PROOF}),
    ("/v1/notes/consolidation",
     {"chain_id": 8453, "asset": "USDC", "proof": _MERGE_PROOF}),
]


@pytest.mark.parametrize("path,body", WRITE_ROUTES, ids=["deposit", "withdrawal", "consolidation"])
@pytest.mark.asyncio
async def test_screening_failure_blocks_with_451(monkeypatch, db_session, path, body):
    # Every screen raises — models both a sanctions hit and an unreachable oracle (fail-closed).
    def _blocked(addr, chain_id):
        raise Sanctioned("Address is sanctioned or screening is unavailable.")
    monkeypatch.setattr("app.services.sanctions.screen_address", _blocked)

    app = _app(monkeypatch, db_session)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post(path, headers={"Authorization": "Bearer sk_test_x",
                                        "X-Wallet-Address": "0xaaa"}, json=body)

    assert r.status_code == 451, f"{path} did not fail closed: {r.status_code} {r.text}"
    assert r.json()["error_code"] == "sanctioned"
    # the blocked tx never reached the executor
    assert "0xSHOULD_NOT_REACH" not in r.text
