"""Solana Devnet through the public API: reads, deposits, relayed payouts/splits, orders, free keys."""
import base64
import hashlib

import base58
import fakeredis
import pytest
from fastapi import Request
from httpx import ASGITransport, AsyncClient
from solders.keypair import Keypair

from app.deps.api_key import verify_api_key
from app.deps.wallet_sig import verify_wallet_intent, verify_wallet_intent_or_sandbox, verify_wallet_sig_or_sandbox
from app.errors import Conflict, NotFound
from app.main import create_app
from app.repository.models import ApiKey, Operation
from app.repository.session import get_db
from app.services import solana_devnet as sd

WALLET = str(Keypair().pubkey())


def _app(monkeypatch, db, *, plan="growth", wallet=WALLET):
    redis = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: redis)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: redis)
    key = ApiKey(id=f"k-{plan}", key_hash=f"h-{plan}", integrator_id="biz", plan=plan, status="active")
    db.add(key)
    db.commit()

    def stash_key(request: Request):
        request.state.api_key_id = key.id
        request.state.sandbox = False
        request.state.devnet_only = plan == "devnet"
        return key

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = stash_key
    app.dependency_overrides[verify_wallet_intent_or_sandbox] = lambda: wallet
    app.dependency_overrides[verify_wallet_sig_or_sandbox] = lambda: wallet
    app.dependency_overrides[verify_wallet_intent] = lambda: wallet
    app.dependency_overrides[get_db] = lambda: db
    return app


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


class FakeAsp:
    def __init__(self, member=True):
        self.member, self.screened = member, []

    def screen(self, body):
        self.screened.append(body)
        return {"decision": "admit"}

    def set_read(self, what, params, caller=None):
        if what == "path":
            if not self.member:
                raise NotFound("not_member")
            return {"leafIndex": 1, "pathElements": ["7"] * 32, "pathIndices": [0] * 32}
        if what == "smt-path":
            return {"pathElements": ["9"] * 32, "pathIndices": [1] * 32, "claimedLeaf": "0"}
        if what == "root":
            return {"admittedRoot": "111", "revokedRoot": "222"}
        if what == "member":
            return {"admitted": self.member, "revoked": False}

    def solana_leaves(self):
        return {"leaves": ["1", "2", "3"], "root": "99", "leafCount": 3}


class FakeExecutor:
    def __init__(self, error=None):
        self.error, self.relayed, self.requests = error, [], []
        self._api_token = "gw-token"

    def relay_solana(self, body, *, wallet, request_id=None):
        self.relayed.append((body, wallet))
        if self.error:
            raise self.error
        return {"ok": True, "commit_sig": "c", "spend_sig": "SpendSig1111"}

    def _request(self, method, path, json=None, headers=None, **_):
        self.requests.append((method, path, json, headers))
        if path == "/solana/settlement":
            return {"pubkey": "Settle1111", "meteoraPool": "Pool1111"}
        if path.startswith("/strategies/") and method == "GET":
            return {"strategies": [{"id": "s1", "status": "EXECUTED", "from_chain": "900002",
                                    "settlement": {"returned_note": {"commitment": "5"}}}]}
        return {"status": "ok"}

    def list_strategies(self, user_id, *, wallet_headers):
        return self._request("GET", f"/strategies/{user_id}", headers=wallet_headers)

    def create_strategy(self, payload, *, wallet_headers):
        self.requests.append(("POST", "/createStrategy", payload, wallet_headers))
        return {"strategy_id": "s9"}

    def has_server_key(self, user_id, *, wallet_headers=None):
        return {"has_key": True}


def _world(monkeypatch, *, asp=None, executor=None):
    asp, executor = asp or FakeAsp(), executor or FakeExecutor()
    monkeypatch.setattr("app.services.v5_chains.asp", lambda _c: asp)
    monkeypatch.setattr("app.routers.v5.asp", lambda _c: asp)
    monkeypatch.setattr("app.services.v5_chains.executor", lambda _c: executor)
    return asp, executor


@pytest.mark.asyncio
async def test_chains_list_solana_and_a_devnet_key_sees_only_it(monkeypatch, db_session):
    async with _client(_app(monkeypatch, db_session, plan="devnet")) as c:
        r = await c.get("/v1/chains")
    assert [x["chain_id"] for x in r.json()["chains"]] == [900002]
    assert r.json()["chains"][0]["program_id"] == "BktHHQ8KJpfnwLNMEqnh9uANEyuFa1qYtbhzHwCKMEDe"


@pytest.mark.asyncio
async def test_a_devnet_key_is_refused_on_evm_chains_and_legacy_routes(monkeypatch, db_session):
    _world(monkeypatch)
    async with _client(_app(monkeypatch, db_session, plan="devnet")) as c:
        evm = await c.get("/v1/chains/8453/state-leaves")
        account = await c.post("/v1/accounts", headers={"Idempotency-Key": "a"},
                               json={"chain_id": 8453, "external_ref": "x"})
        ok = await c.get("/v1/chains/900002/state-leaves")
    assert evm.status_code == 403 and account.status_code == 403
    assert ok.status_code == 200 and ok.json()["leaves"] == ["1", "2", "3"]


@pytest.mark.asyncio
async def test_vault_state_carries_the_settlement_wallet(monkeypatch, db_session):
    _world(monkeypatch)
    monkeypatch.setattr(sd, "vault_state", lambda: {
        "program_version": 5, "deposit_nonce": 3, "deposits_paused": False, "allowed_mint": "M",
        "scope_id": "6", "leaf_count": 5, "state_root": "1", "admitted_root": "2", "revoked_root": "3"})
    async with _client(_app(monkeypatch, db_session)) as c:
        r = await c.get("/v1/chains/900002/vault")
        evm = await c.get("/v1/chains/8453/vault")
    assert r.status_code == 200 and r.json()["deposit_nonce"] == 3 and r.json()["settlement_wallet"] == "Settle1111"
    assert evm.status_code == 400


@pytest.mark.asyncio
async def test_witness_checks_the_roots_on_the_compliance_account(monkeypatch, db_session):
    _world(monkeypatch)
    monkeypatch.setattr(sd, "compliance_roots", lambda: ("111", "222"))
    async with _client(_app(monkeypatch, db_session)) as c:
        r = await c.get("/v1/chains/900002/compliance/witness", params={"labels": ["42"]})
    assert r.status_code == 200, r.text
    assert r.json()["admittedRoot"] == "111" and r.json()["inputs"][0]["admittedLeafIndex"] == 1
    monkeypatch.setattr(sd, "compliance_roots", lambda: ("110", "222"))
    async with _client(_app(monkeypatch, db_session, plan="starter")) as c:
        stale = await c.get("/v1/chains/900002/compliance/witness", params={"labels": ["42"]})
    assert stale.status_code == 409  # roots still publishing → retry


@pytest.mark.asyncio
async def test_an_unadmitted_label_is_pending_not_an_error(monkeypatch, db_session):
    _world(monkeypatch, asp=FakeAsp(member=False))
    monkeypatch.setattr(sd, "compliance_roots", lambda: ("111", "222"))
    async with _client(_app(monkeypatch, db_session)) as c:
        r = await c.get("/v1/chains/900002/compliance/witness", params={"labels": ["42"]})
        ragequit = await c.get("/v1/chains/900002/compliance/witness", params={"labels": ["42"], "require_admitted": "false"})
    assert r.status_code == 409 and ragequit.status_code == 200


async def _account(c):
    r = await c.post("/v1/accounts", headers={"Idempotency-Key": "acct"},
                     json={"chain_id": 900002, "external_ref": "user-1"})
    assert r.status_code == 201, r.text
    return r.json()["account_id"]


@pytest.mark.asyncio
async def test_deposit_returns_a_simulated_transaction_and_screens_the_commitment(monkeypatch, db_session):
    asp, _ = _world(monkeypatch)
    calls = []

    def plan(**kw):
        calls.append(kw)
        return {"transaction": base64.b64encode(b"tx").decode(), "deposit_data_sha256": "ab" * 32, "last_valid_block_height": 9}

    monkeypatch.setattr(sd, "deposit_plan", plan)
    seen = []
    monkeypatch.setattr(sd, "validate_submitted_deposit",
                        lambda sig, **kw: seen.append((sig, kw)))
    async with _client(_app(monkeypatch, db_session)) as c:
        acct = await _account(c)
        body = {"chain_id": 900002, "asset": "SOL", "amount_minor": 10_000_000, "precommitment": "5",
                "user_salt": "7", "commitment": "11"}
        missing = await c.post(f"/v1/accounts/{acct}/deposits", headers={"Idempotency-Key": "d0"},
                               json={**body, "commitment": None})
        r = await c.post(f"/v1/accounts/{acct}/deposits", headers={"Idempotency-Key": "d1"}, json=body)
        op_id = r.json()["operation"]["operation_id"]
        sub = await c.post(f"/v1/operations/{op_id}/submission", json={"chain_id": 900002, "tx_hash": "Sig111"})
    assert missing.status_code == 400
    assert r.status_code == 200, r.text
    assert r.json()["transactions"][0]["encoding"] == "base64" and calls[0]["commitment"] == "11"
    # The depositor goes to solasp verbatim (base58 is case-sensitive) with the DECIMAL commitment.
    assert asp.screened[0]["depositor"] == WALLET and asp.screened[0]["commitment"] == "11"
    assert sub.status_code == 200, sub.text
    assert seen == [("Sig111", {"wallet": WALLET, "expected_data_sha256": "ab" * 32})]
    op = db_session.get(Operation, op_id)
    assert op.detail["protocol"] == "solana" and op.detail["admission"] == "asp_watcher"


def _spend(amount=500, action=0):
    p = ["0"] * 25
    p[0], p[1], p[5], p[16], p[9] = str(action), "1", str(amount), "5", "12345"
    p[17] = str(sd.asset_id(sd.usdc_mint()))
    return {"public_inputs": p, "proof_hex": "ab" * 256, "circuit_index": 12 if action == 3 else 0}


@pytest.mark.asyncio
async def test_payout_is_relayed_with_the_recipient_the_proof_binds(monkeypatch, db_session):
    _, executor = _world(monkeypatch)
    recipient = str(Keypair().pubkey())
    async with _client(_app(monkeypatch, db_session)) as c:
        acct = await _account(c)
        body = {"chain_id": 900002, "account_id": acct, "asset": "USDC", "recipient": recipient,
                "amount_minor": 500, "solana_spend": _spend()}
        r = await c.post("/v1/payouts", headers={"Idempotency-Key": "p1"}, json=body)
        wrong = await c.post("/v1/payouts", headers={"Idempotency-Key": "p2"}, json={**body, "amount_minor": 499})
        evm_shape = await c.post("/v1/payouts", headers={"Idempotency-Key": "p3"},
                                 json={**body, "solana_spend": None})
    assert r.status_code == 200, r.text
    assert r.json()["tx_hash"] == "SpendSig1111" and r.json()["operation"]["status"] == "submitted"
    relayed, wallet = executor.relayed[0]
    assert relayed["recipient"] == recipient and wallet == WALLET
    assert relayed["package"]["nullifiers_hex"] == [sd.le32(12345).hex()]
    assert wrong.status_code == 400 and evm_shape.status_code == 400


@pytest.mark.asyncio
async def test_a_refused_relay_settles_the_operation_failed(monkeypatch, db_session):
    _world(monkeypatch, executor=FakeExecutor(error=Conflict("spend rejected: roots moved — prove again")))
    async with _client(_app(monkeypatch, db_session)) as c:
        acct = await _account(c)
        r = await c.post("/v1/payouts", headers={"Idempotency-Key": "p1"}, json={
            "chain_id": 900002, "account_id": acct, "asset": "USDC", "recipient": str(Keypair().pubkey()),
            "amount_minor": 500, "solana_spend": _spend()})
    assert r.status_code == 409
    op = db_session.query(Operation).filter_by(kind="payout").one()
    assert op.state == "failed"


@pytest.mark.asyncio
async def test_split_is_relayed_with_eight_slices(monkeypatch, db_session):
    _, executor = _world(monkeypatch)
    async with _client(_app(monkeypatch, db_session)) as c:
        acct = await _account(c)
        r = await c.post("/v1/splits", headers={"Idempotency-Key": "s1"}, json={
            "chain_id": 900002, "account_id": acct, "solana_spend": _spend(amount=0, action=3),
            "split_commitments": ["1", "2", "0", "0", "0", "0", "0", "0"]})
    assert r.status_code == 200, r.text
    assert r.json()["operation"]["kind"] == "split"
    assert "recipient" not in executor.relayed[0][0] and len(executor.relayed[0][0]["package"]["split_commitments_hex"]) == 8


@pytest.mark.asyncio
async def test_devnet_orders_go_to_the_devnet_executor_with_the_gateway_attestation(monkeypatch, db_session):
    _, executor = _world(monkeypatch)
    async with _client(_app(monkeypatch, db_session, plan="devnet")) as c:
        evm = await c.post("/v1/strategies", headers={"Idempotency-Key": "o0"},
                           json={"from_chain": "8453", "strategy_type": "LIMIT_SELL"})
        r = await c.post("/v1/strategies", headers={"Idempotency-Key": "o1", "Authorization": "Bearer sk_live_x"},
                         json={"from_chain": "900002", "strategy_type": "LIMIT_SELL", "asset_in": "SOL",
                               "asset_out": "USDC", "amount": 0.1})
        got = await c.get("/v1/strategies/s1")
        reprove = await c.post("/v1/strategies/s1/reprove", json={"zkp_data": {"proof_hex": "00"}, "leg_index": 2})
    assert evm.status_code == 403
    assert r.status_code == 200, r.text
    _, path, payload, headers = next(x for x in executor.requests if x[1] == "/createStrategy")
    assert payload["user_id"] == WALLET and headers["X-Siphon-Gateway-Token"] == "gw-token"
    assert got.status_code == 200 and got.json()["settlement"]["returned_note"]["commitment"] == "5"
    _, path, payload, headers = executor.requests[-1]
    assert path == "/executeStrategy" and payload["refresh_only"] is True and payload["leg_index"] == 2


@pytest.mark.asyncio
async def test_free_devnet_key_one_per_wallet(monkeypatch, db_session):
    delivery = bytes(range(32))
    headers = {"X-Delivery-Key": "0x" + delivery.hex()}
    body = {"chain_id": 900002, "delivery_key_sha256": hashlib.sha256(delivery).hexdigest()}
    async with _client(_app(monkeypatch, db_session)) as c:
        first = await c.post("/v1/keys/devnet", headers={**headers, "Idempotency-Key": "c1"}, json=body)
        replay = await c.post("/v1/keys/devnet", headers={**headers, "Idempotency-Key": "c1"}, json=body)
        second = await c.post("/v1/keys/devnet", headers={**headers, "Idempotency-Key": "c2"}, json=body)
        evm_chain = await c.post("/v1/keys/devnet", headers={**headers, "Idempotency-Key": "c3"},
                                 json={**body, "chain_id": 8453})
    assert first.status_code == 200, first.text
    assert first.json()["plan"] == "devnet" and first.json()["chain_ids"] == [900002]
    assert replay.json()["api_key"] == first.json()["api_key"]
    assert second.status_code == 200 and second.json()["revoked_previous"] == 1
    assert evm_chain.status_code == 400
    statuses = {k.id: k.status for k in db_session.query(ApiKey).filter_by(plan="devnet")}
    assert statuses == {first.json()["api_key_id"]: "revoked", second.json()["api_key_id"]: "active"}


@pytest.mark.asyncio
async def test_free_devnet_keys_are_for_solana_wallets(monkeypatch, db_session):
    delivery = bytes(range(32))
    async with _client(_app(monkeypatch, db_session, wallet="0x" + "11" * 20)) as c:
        r = await c.post("/v1/keys/devnet", headers={"X-Delivery-Key": "0x" + delivery.hex(), "Idempotency-Key": "c"},
                         json={"chain_id": 900002, "delivery_key_sha256": hashlib.sha256(delivery).hexdigest()})
    assert r.status_code == 400
