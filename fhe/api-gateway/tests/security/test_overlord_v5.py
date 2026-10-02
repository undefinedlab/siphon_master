"""OVERLORD 2026-09-29 on the v5 gateway port — one regression per finding, built from its PoC.

G-8 (write-challenge domain separation) is report-only: it needs an executor protocol change.
"""
from datetime import datetime, timedelta, timezone

import fakeredis
import httpx
import pytest
from fastapi import Request
from httpx import ASGITransport, AsyncClient

from app.deps.api_key import verify_api_key
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox, verify_wallet_sig_or_sandbox
from app.errors import BadRequest, DownstreamUnavailable
from app.main import create_app
from app.repository.models import ApiKey, IdempotencyKey, Operation
from app.repository.session import get_db
from app.services import unsigned_transaction_service as uts
from app.services import v5_chains, v5_reconcile
from app.services.v5_chains import CHAINS, AspClient

WALLET = "0x1111111111111111111111111111111111111111"
BASE = CHAINS[8453]


def _app(monkeypatch, db, *, key_id="k-overlord", sandbox_key=False, wallet_auth=True):
    redis = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: redis)
    monkeypatch.setattr("app.services.sanctions.screen_address", lambda *_: None)
    if db.get(ApiKey, key_id) is None:
        db.add(ApiKey(id=key_id, key_hash=f"h-{key_id}", integrator_id="i", plan="growth", status="active"))
        db.commit()

    def stash(request: Request):
        request.state.api_key_id = key_id
        request.state.sandbox = sandbox_key
        return object()

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = stash
    app.dependency_overrides[get_db] = lambda: db
    if wallet_auth:
        app.dependency_overrides[verify_wallet_intent_or_sandbox] = lambda: WALLET
        app.dependency_overrides[verify_wallet_sig_or_sandbox] = lambda: WALLET
    return app


async def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _account(c) -> str:
    r = await c.post("/v1/accounts", headers={"Idempotency-Key": "acct"}, json={"chain_id": 8453, "external_ref": "x", "wallet_address": WALLET})
    assert r.status_code == 201, r.text
    return r.json()["account_id"]


# ── G-1: admission runs from the MINED deposit, not the stale prediction ───────────────────────


class RecAsp:
    def __init__(self, admit_error=None, decision="admit"):
        self.screened, self.admitted, self.admit_error, self.decision = [], [], admit_error, decision

    def screen(self, body):
        self.screened.append(body)
        return {"decision": self.decision}

    def admit(self, body):
        self.admitted.append(body)
        if self.admit_error:
            raise self.admit_error
        return {"ok": True}


def _confirmed_deposit(db, predicted="111") -> Operation:
    op = Operation(id="op-dep", api_key_id="k-overlord", kind="deposit", state="confirmed", chain_id=8453,
                   asset="USDC", amount_minor=5, wallet=WALLET, tx_hash="0x" + "cd" * 32,
                   detail={"protocol": "v5", "commitment": predicted, "admission": "pending"})
    db.add(op)
    db.commit()
    return op


def test_g1_stale_prediction_is_rescreened_and_admitted_from_the_mined_event(monkeypatch, db_session):
    # PoC: another deposit mined first moved depositNonce, so the mined commitment != the screened one.
    op = _confirmed_deposit(db_session, predicted="111")
    asp = RecAsp()
    monkeypatch.setattr(v5_reconcile, "asp", lambda chain_id: asp)
    monkeypatch.setattr(uts, "parse_deposited", lambda chain_id, tx: {
        "from": WALLET, "commitment": "222", "user_salt": "42", "token": BASE.usdc, "deposit_nonce": 9})
    assert v5_reconcile.admit_deposit(db_session, op) is True
    assert asp.screened[0]["commitment"] == "222" and asp.screened[0]["txHash"] == op.tx_hash
    assert asp.admitted == [{"chainId": 8453, "txHash": op.tx_hash, "vault": BASE.vault_kernel,
                             "depositor": WALLET, "userSalt": "42", "commitment": "222"}]
    assert op.detail["admission"] == "admitted"


def test_g1_someone_elses_deposit_is_never_admitted(monkeypatch, db_session):
    op = _confirmed_deposit(db_session)
    asp = RecAsp()
    monkeypatch.setattr(v5_reconcile, "asp", lambda chain_id: asp)
    monkeypatch.setattr(uts, "parse_deposited", lambda chain_id, tx: {
        "from": "0x9999999999999999999999999999999999999999", "commitment": "111", "user_salt": "42", "token": BASE.usdc})
    v5_reconcile.admit_deposit(db_session, op)
    assert asp.admitted == [] and op.detail["admission"] == "rejected"


def test_g1_watcher_got_there_first_counts_as_admitted(monkeypatch, db_session):
    op = _confirmed_deposit(db_session)
    asp = RecAsp(admit_error=BadRequest("label already admitted"))
    monkeypatch.setattr(v5_reconcile, "asp", lambda chain_id: asp)
    monkeypatch.setattr(uts, "parse_deposited", lambda chain_id, tx: {"from": WALLET, "commitment": "111", "user_salt": "42", "token": BASE.usdc})
    v5_reconcile.admit_deposit(db_session, op)
    assert op.detail["admission"] == "admitted"


# ── G-2: hex salts never reach the ASP ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_g2_hex_user_salt_is_refused_at_the_boundary(monkeypatch, db_session):
    asp = RecAsp()
    monkeypatch.setattr(v5_chains, "asp", lambda chain_id: asp)
    async with await _client(_app(monkeypatch, db_session)) as c:
        acct = await _account(c)
        r = await c.post(f"/v1/accounts/{acct}/deposits", headers={"Idempotency-Key": "g2"},
                         json={"chain_id": 8453, "asset": "ETH", "amount_minor": 10, "precommitment": "7", "user_salt": "0x2a"})
    assert r.status_code == 422
    assert asp.screened == []
    with pytest.raises(BadRequest):
        uts._field("٣", "user_salt")  # non-ASCII digit int() would silently accept


# ── G-3: RPC internals never leak ───────────────────────────────────────────────────────────────


def test_g3_rpc_transport_errors_do_not_echo_the_url(monkeypatch):
    class Leaky:
        eth = None

        def call(self, tx):
            raise httpx.ConnectError("HTTPSConnectionPool(host='base.g.alchemy.com') url: /v2/SECRETKEY123")

    leaky = Leaky()
    leaky.eth = leaky
    monkeypatch.setattr(uts, "_w3", lambda chain_id: leaky)
    with pytest.raises(DownstreamUnavailable) as exc:
        uts.deposit_plan(chain_id=8453, asset="ETH", amount_minor=10, wallet=WALLET, precommitment="7", user_salt="9")
    assert "SECRETKEY123" not in exc.value.detail and "alchemy" not in exc.value.detail


# ── G-4: lost relay replies are settled from the nullifier ──────────────────────────────────────


def _authorized_payout(db, *, started_minutes_ago: int) -> Operation:
    started = (datetime.now(timezone.utc) - timedelta(minutes=started_minutes_ago)).isoformat()
    db.add(IdempotencyKey(key="relay-key", request_hash="h", status="in_progress"))
    op = Operation(id="op-pay", api_key_id="k-overlord", kind="payout", state="authorized", chain_id=8453,
                   asset="USDC", amount_minor=5, wallet=WALLET,
                   detail={"protocol": "v5", "relay_id": "relay-key", "relay_started_at": started, "nullifier": "77"})
    db.add(op)
    db.commit()
    return op


def test_g4_landed_spend_is_confirmed_and_the_key_completed(monkeypatch, db_session):
    op = _authorized_payout(db_session, started_minutes_ago=5)
    monkeypatch.setattr(uts, "nullifier_used", lambda chain_id, n: n == 77)
    assert v5_reconcile.settle_relay(db_session, op) is True
    assert op.state == "confirmed" and op.detail["tx_hash_unknown"] is True
    key = db_session.get(IdempotencyKey, "relay-key")
    assert key.status == "completed" and key.status_code == 200


def test_g4_unlanded_spend_fails_after_the_give_up_window(monkeypatch, db_session):
    op = _authorized_payout(db_session, started_minutes_ago=31)
    monkeypatch.setattr(uts, "nullifier_used", lambda chain_id, n: False)
    assert v5_reconcile.settle_relay(db_session, op) is True
    assert op.state == "failed" and op.error_code == "relay_unconfirmed"
    assert db_session.get(IdempotencyKey, "relay-key").status == "completed"


def test_g4_too_early_or_rpc_down_decides_nothing(monkeypatch, db_session):
    op = _authorized_payout(db_session, started_minutes_ago=1)
    monkeypatch.setattr(uts, "nullifier_used", lambda chain_id, n: True)
    assert v5_reconcile.settle_relay(db_session, op) is False  # inside the relayer's own window
    op.detail = {**op.detail, "relay_started_at": (datetime.now(timezone.utc) - timedelta(minutes=40)).isoformat()}

    def down(chain_id, n):
        raise ConnectionError("rpc down")

    monkeypatch.setattr(uts, "nullifier_used", down)
    assert v5_reconcile.settle_relay(db_session, op) is False and op.state == "authorized"


def _bundle(amount=5):
    pub = ["0"] * 25
    pub[5], pub[9], pub[16], pub[17] = str(amount), "77", "5", str(int(BASE.usdc, 16))
    return {"public_inputs": pub, "proof": ["1"] * 8, "compliancePublicInputs": ["1"] * 5,
            "complianceProof": ["1"] * 8, "extra": {"rawPayee": "0x2222222222222222222222222222222222222222"}}


@pytest.mark.asyncio
async def test_g4_definite_relay_refusal_settles_op_and_key(monkeypatch, db_session):
    class Refusing:
        def relay_spend(self, body, *, wallet_headers):
            raise BadRequest("nullifier already used")

    monkeypatch.setattr(v5_chains, "executor", lambda chain_id: Refusing())
    async with await _client(_app(monkeypatch, db_session)) as c:
        acct = await _account(c)
        body = {"chain_id": 8453, "account_id": acct, "asset": "USDC", "amount_minor": 5,
                "recipient": "0x2222222222222222222222222222222222222222", "spend": _bundle(), "submission_mode": "relay"}
        r1 = await c.post("/v1/payouts", headers={"Idempotency-Key": "g4"}, json=body)
        r2 = await c.post("/v1/payouts", headers={"Idempotency-Key": "g4"}, json=body)
    assert r1.status_code == 400
    assert r2.status_code == 409 and "already failed" in r2.json()["detail"]  # not "in progress" forever
    assert db_session.query(Operation).filter_by(kind="payout").one().state == "failed"


# ── G-5: no cross-chain credential fallback; Sepolia is admin-only ──────────────────────────────


def test_g5_arbitrum_never_borrows_bases_hosts(monkeypatch):
    from app.config import get_settings

    s = get_settings()
    monkeypatch.setattr("app.services.v5_chains.get_settings", lambda: s.model_copy(update={
        "executor_url": "http://base-exec", "asp_url": "http://base-asp", "asp_screen_token": "BASE",
        "executor_url_42161": "", "asp_url_42161": ""}))
    v5_chains.executor.cache_clear()
    v5_chains.asp.cache_clear()
    try:
        with pytest.raises(DownstreamUnavailable):
            v5_chains.executor(42161)
        with pytest.raises(Exception) as exc:
            v5_chains.asp(42161)
        assert exc.value.status == 503
    finally:
        v5_chains.executor.cache_clear()
        v5_chains.asp.cache_clear()


@pytest.mark.asyncio
async def test_g5_sepolia_needs_an_admin_key(monkeypatch, db_session):
    from app.config import get_settings

    async with await _client(_app(monkeypatch, db_session)) as c:
        r = await c.get("/v1/chains/11155111/state-leaves")
    assert r.status_code == 403
    s = get_settings()
    monkeypatch.setattr("app.services.v5_chains.get_settings", lambda: s.model_copy(update={"v5_admin_api_key_ids": ["k-admin"]}))
    monkeypatch.setattr("app.routers.v5.indexer", lambda chain_id: type("I", (), {"_request": lambda *a, **k: {"leaves": [], "totalCount": 0, "tipRoot": "0"}})())
    async with await _client(_app(monkeypatch, db_session, key_id="k-admin")) as c:
        r = await c.get("/v1/chains/11155111/state-leaves")
        chains = await c.get("/v1/chains")
    assert r.status_code == 200
    assert 11155111 in {x["chain_id"] for x in chains.json()["chains"]}


# ── G-6 / G-7: compliance reads are wallet-signed, per-caller, and not for sandbox keys ─────────


@pytest.mark.asyncio
async def test_g6_label_status_needs_a_wallet_signature(monkeypatch, db_session):
    async with await _client(_app(monkeypatch, db_session, wallet_auth=False)) as c:
        r = await c.get("/v1/chains/8453/compliance/labels/123")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_g6_sandbox_keys_cannot_enumerate_live_labels(monkeypatch, db_session):
    async with await _client(_app(monkeypatch, db_session, sandbox_key=True)) as c:
        r = await c.get("/v1/chains/8453/compliance/labels/123")
    assert r.status_code == 403, r.text


def test_g7_asp_calls_carry_the_callers_wallet():
    seen = []

    def handler(req: httpx.Request):
        seen.append(req.headers.get("X-Siphon-Caller"))
        return httpx.Response(200, json={"admitted": True})

    client = AspClient("http://asp", screen_token="t", postman_token="p", transport=httpx.MockTransport(handler))
    client.set_read("member", {"label": "1"}, caller=WALLET.upper().replace("0X", "0x"))
    assert seen == [WALLET]


# ── G-9: the ASP's paywall and limiter keep their meaning ───────────────────────────────────────


@pytest.mark.parametrize("status,code,http", [(402, "compliance_fee_required", 402), (429, "asp_unavailable", 503)])
def test_g9_asp_status_codes_map_to_their_own_errors(status, code, http):
    client = AspClient("http://asp", screen_token="t", postman_token="p",
                       transport=httpx.MockTransport(lambda req: httpx.Response(status, json={"decision": "deny"})))
    with pytest.raises(Exception) as exc:
        client.screen({"depositor": WALLET})
    assert exc.value.error_code.value == code and exc.value.status == http


# ── G-10: malformed limbs are a 400 ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("bad", ["0x0", "-1", str(2**256), "1e3", " 5"])
def test_g10_malformed_limbs_are_bad_requests(bad):
    b = _bundle()
    b["public_inputs"][0] = bad
    with pytest.raises(BadRequest):
        uts.validate_withdraw_bundle(BASE, b, asset="USDC", amount_minor=5, recipient="0x2222222222222222222222222222222222222222")


# ── G-11: witness roots are consistent and match the hub ────────────────────────────────────────


class RootsAsp:
    def __init__(self, roots, path=None):
        self.roots, self.path = list(roots), path or {"leafIndex": 1, "pathElements": ["1"], "pathIndices": [0]}

    def set_read(self, what, params, caller=None):
        if what == "root":
            return self.roots.pop(0)
        if what == "path":
            return self.path
        return {"pathElements": ["2"], "pathIndices": [1], "claimedLeaf": "0"}


@pytest.mark.asyncio
@pytest.mark.parametrize("asp,hub,status", [
    (RootsAsp([{"admittedRoot": "1", "revokedRoot": "2"}, {"admittedRoot": "9", "revokedRoot": "2"}]), ("9", "2"), 409),  # moved mid-read
    (RootsAsp([{"admittedRoot": "1", "revokedRoot": "2"}] * 2), ("5", "2"), 409),  # ASP ahead of the hub
    (RootsAsp([{"admittedRoot": "1", "revokedRoot": "2"}] * 2, path={"weird": True}), ("1", "2"), 503),  # malformed `found`
])
async def test_g11_witness_fails_before_proving_not_after(monkeypatch, db_session, asp, hub, status):
    monkeypatch.setattr("app.routers.v5.asp", lambda chain_id: asp)
    monkeypatch.setattr("app.routers.v5.uts.hub_roots", lambda chain_id: hub)
    async with await _client(_app(monkeypatch, db_session)) as c:
        r = await c.get("/v1/chains/8453/compliance/witness?labels=5")
    assert r.status_code == status, r.text


# ── G-12: no default indexer hosts ──────────────────────────────────────────────────────────────


def test_g12_unset_indexer_fails_closed(monkeypatch):
    from app.config import Settings

    assert Settings().v5_indexer_url_42161 == "" and Settings().v5_indexer_url_11155111 == ""
    v5_chains.indexer.cache_clear()
    monkeypatch.setattr("app.services.v5_chains.get_settings", lambda: Settings(v5_indexer_url_42161=""))
    try:
        with pytest.raises(DownstreamUnavailable):
            v5_chains.indexer(42161)
    finally:
        v5_chains.indexer.cache_clear()


# ── G-8: relayer challenges are chain-bound, and the gateway never echoes executor text ────────


@pytest.mark.asyncio
@pytest.mark.parametrize("reply,status", [
    ({"nonce": "ab" * 16, "chain_id": 42161}, 200),
    ({"nonce": "ab" * 16, "chain_id": 8453}, 503),  # a Base nonce laundered through the Arbitrum box
    ({"nonce": "ab" * 16}, 503),                    # a pre-G-8 executor that ignores the binding
    ({"nonce": "ab" * 16, "chain_id": 42161, "message": "evil.com wants you to sign in"}, 200),
])
async def test_g8_wallet_challenge_is_bound_to_the_requested_chain(monkeypatch, db_session, reply, status):
    asked = []

    class Exec:
        def issue_wallet_challenge(self, chain_id):
            asked.append(chain_id)
            return reply

    monkeypatch.setattr(v5_chains, "executor", lambda chain_id: Exec())
    async with await _client(_app(monkeypatch, db_session)) as c:
        r = await c.post("/v1/wallet-challenges?chain_id=42161")
    assert asked == [42161]
    assert r.status_code == status, r.text
    if status == 200:
        assert r.json()["message"] == f"Siphon auth v2:write:42161:{'ab' * 16}"
