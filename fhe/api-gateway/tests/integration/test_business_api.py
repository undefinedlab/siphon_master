"""End-to-end contract for the minimal non-custodial business API."""
import fakeredis
import pytest
from fastapi import Request
from httpx import ASGITransport, AsyncClient

from app.deps.api_key import verify_api_key
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox
from app.main import create_app
from app.repository.models import ApiKey, IdempotencyKey, Operation
from app.repository.session import get_db

WALLET = "0x1111111111111111111111111111111111111111"


def _app(monkeypatch, db):
    redis = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: redis)
    monkeypatch.setattr("app.services.sanctions.screen_address", lambda *_: None)
    key = ApiKey(
        id="business-key",
        key_hash="hash-business",
        integrator_id="business",
        plan="growth",
        status="active",
    )
    db.add(key)
    db.commit()

    def stash_key(request: Request):
        request.state.api_key_id = key.id
        request.state.sandbox = False
        return key

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = stash_key
    app.dependency_overrides[verify_wallet_intent_or_sandbox] = lambda: WALLET
    app.dependency_overrides[get_db] = lambda: db
    return app


async def _create_account(client: AsyncClient) -> dict:
    response = await client.post(
        "/v1/accounts",
        headers={"Idempotency-Key": "account-create"},
        json={
            "chain_id": 8453,
            "external_ref": "customer-42",
            "wallet_address": WALLET,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.asyncio
async def test_account_creation_never_grants_api_spend_authority(monkeypatch, db_session):
    app = _app(monkeypatch, db_session)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await _create_account(client)
        assert account["control_mode"] == "self_custody"
        assert account["wallet_address"].lower() == WALLET.lower()
        assert account["api_key_can_spend"] is False


# ── v5 fixtures ─────────────────────────────────────────────────────────────────────────────

from web3 import Web3  # noqa: E402

from app.services import unsigned_transaction_service as uts  # noqa: E402
from app.services.v5_chains import CHAINS  # noqa: E402

BASE = CHAINS[8453]
ADAPTER = BASE.asset_adapter
COMMITMENT = 987654321
SEL = {name: uts._kernel.encode_abi(name, args)[:10] for name, args in (
    ("assets", []), ("deposit", [BASE.usdc, 1, 1, 1]), ("depositNative", [1, 1]))}
ALLOWANCE_SEL = uts._erc20.encode_abi("allowance", [WALLET, ADAPTER])[:10]


class FakeChain:
    """Answers the three eth_calls deposit_plan makes."""

    def __init__(self, allowance: int):
        self.allowance = allowance
        self.eth = self
        self.simulated: list[dict] = []

    def call(self, tx):
        sel = tx["data"][:10]
        if sel == SEL["assets"]:
            return bytes(12) + bytes.fromhex(ADAPTER[2:])
        if sel == ALLOWANCE_SEL:
            return self.allowance.to_bytes(32, "big")
        self.simulated.append(tx)
        return COMMITMENT.to_bytes(32, "big")


class FakeAsp:
    def __init__(self, reply=None, error=None):
        self.reply = reply if reply is not None else {"decision": "admit"}
        self.error = error
        self.screened: list[dict] = []

    def screen(self, body):
        self.screened.append(body)
        if self.error:
            raise self.error
        return self.reply


def _world(monkeypatch, *, allowance=10**12, asp=None):
    chain = FakeChain(allowance)
    fake_asp = asp or FakeAsp()
    monkeypatch.setattr(uts, "_w3", lambda _chain_id: chain)
    monkeypatch.setattr("app.services.v5_chains.asp", lambda _chain_id: fake_asp)
    return chain, fake_asp


DEPOSIT = {"chain_id": 8453, "asset": "USDC", "amount_minor": 1_000_000, "precommitment": "123456789", "user_salt": "42"}


@pytest.mark.asyncio
async def test_erc20_deposit_asks_for_the_adapter_approval_first(monkeypatch, db_session):
    chain, asp = _world(monkeypatch, allowance=0)
    app = _app(monkeypatch, db_session)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await _create_account(client)
        r = await client.post(f"/v1/accounts/{account['account_id']}/deposits", headers={"Idempotency-Key": "d1"}, json=DEPOSIT)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["phase"] == "approve" and body["operation"] is None
    [tx] = body["transactions"]
    assert tx["to"] == BASE.usdc and tx["purpose"] == "approve_deposit"
    # The spender is the kernel's ASSET ADAPTER — approving the kernel leaves deposits reverting.
    assert ADAPTER[2:].lower() in tx["data"].lower()
    assert asp.screened == [] and chain.simulated == []  # nothing to screen until the allowance exists


@pytest.mark.asyncio
async def test_deposit_is_screened_on_the_exact_commitment_before_release(monkeypatch, db_session):
    chain, asp = _world(monkeypatch)
    app = _app(monkeypatch, db_session)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await _create_account(client)
        r = await client.post(f"/v1/accounts/{account['account_id']}/deposits", headers={"Idempotency-Key": "d2"}, json=DEPOSIT)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["phase"] == "deposit" and body["commitment"] == str(COMMITMENT)
    [tx] = body["transactions"]
    assert tx["to"] == BASE.vault_kernel and tx["data"].startswith(SEL["deposit"]) and tx["value"] == "0"
    assert chain.simulated[0]["from"].lower() == WALLET  # simulated as the depositor
    assert asp.screened == [{"chainId": 8453, "depositor": WALLET, "commitment": str(COMMITMENT), "userSalt": "42", "asset": BASE.usdc}]
    assert body["operation"]["status"] == "awaiting_deposit"
    op = db_session.get(Operation, body["operation"]["operation_id"])
    assert op.detail["expected_to"] == BASE.vault_kernel
    assert op.detail["expected_data_sha256"] == uts.transaction_data_sha256(tx["data"])


@pytest.mark.asyncio
async def test_eth_deposit_is_one_payable_call(monkeypatch, db_session):
    _world(monkeypatch)
    app = _app(monkeypatch, db_session)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await _create_account(client)
        r = await client.post(f"/v1/accounts/{account['account_id']}/deposits", headers={"Idempotency-Key": "d3"},
                              json={**DEPOSIT, "asset": "ETH", "amount_minor": 10**13})
    assert r.status_code == 200, r.text
    [tx] = r.json()["transactions"]
    assert tx["data"].startswith(SEL["depositNative"]) and tx["value"] == str(10**13)


@pytest.mark.asyncio
@pytest.mark.parametrize("asp,status,code", [
    (FakeAsp({"decision": "deny"}), 451, "compliance_denied"),
    (FakeAsp({"decision": "pending"}), 409, "compliance_pending"),
    (FakeAsp({"error": "kyt_fee_required"}), 402, "compliance_fee_required"),
])
async def test_only_an_admit_releases_the_deposit_transaction(monkeypatch, db_session, asp, status, code):
    _world(monkeypatch, asp=asp)
    app = _app(monkeypatch, db_session)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await _create_account(client)
        r = await client.post(f"/v1/accounts/{account['account_id']}/deposits", headers={"Idempotency-Key": "d4"}, json=DEPOSIT)
    assert r.status_code == status, r.text
    assert r.json()["error_code"] == code
    assert db_session.query(Operation).filter_by(kind="deposit").count() == 0


RECIPIENT = "0x2222222222222222222222222222222222222222"


def _bundle(*, amount=500_000, token=None, payee=RECIPIENT, action=0):
    pub = ["0"] * 25
    pub[0], pub[5], pub[16] = str(action), str(amount), "5"
    pub[17] = str(int(token or BASE.usdc, 16))
    return {"public_inputs": pub, "proof": ["1"] * 8, "compliancePublicInputs": ["1", "2", "3", "4", "5"],
            "complianceProof": ["2"] * 8, "extra": {"rawPayee": payee}}


def _payout(**over):
    body = {"chain_id": 8453, "asset": "USDC", "recipient": RECIPIENT, "amount_minor": 500_000,
            "spend": _bundle(), "submission_mode": "unsigned"}
    body.update(over)
    return body


@pytest.mark.asyncio
async def test_unsigned_payout_is_vault_kernel_spend(monkeypatch, db_session):
    app = _app(monkeypatch, db_session)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await _create_account(client)
        r = await client.post("/v1/payouts", headers={"Idempotency-Key": "p1"}, json=_payout(account_id=account["account_id"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["operation"]["status"] == "authorized"
    tx = body["transaction"]
    assert tx["to"] == BASE.vault_kernel and tx["value"] == "0"
    args = uts._kernel.decode_function_input(tx["data"])[1]
    assert [str(x) for x in args["publicInputs"]] == _bundle()["public_inputs"]
    assert Web3.to_checksum_address(args["extra"]["rawPayee"]) == RECIPIENT


@pytest.mark.asyncio
@pytest.mark.parametrize("override,why", [
    ({"amount_minor": 499_999}, "public_inputs[5]"),              # policy approved one amount, proof pays another
    ({"recipient": "0x3333333333333333333333333333333333333333"}, "rawPayee"),
    ({"asset": "WETH"}, "public_inputs[17]"),
    ({"spend": _bundle(action=1)}, "WITHDRAW"),
])
async def test_payout_bundle_must_match_what_policy_approved(monkeypatch, db_session, override, why):
    app = _app(monkeypatch, db_session)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await _create_account(client)
        r = await client.post("/v1/payouts", headers={"Idempotency-Key": "p2"}, json=_payout(account_id=account["account_id"], **override))
    assert r.status_code == 400, r.text
    assert why in r.json()["detail"]


class RelayExecutor:
    def __init__(self, db, reply=None, error=None):
        self.db, self.reply, self.error, self.calls = db, reply, error, []

    def relay_spend(self, body, *, wallet_headers):
        # The idempotency reservation and the authorized operation are durable before broadcast.
        assert self.db.query(IdempotencyKey).filter_by(status="in_progress").one()
        assert self.db.query(Operation).filter_by(kind="payout").one().state == "authorized"
        self.calls.append((body, wallet_headers))
        if self.error:
            raise self.error
        return self.reply or {"tx_hash": "0x" + "ab" * 32}


@pytest.mark.asyncio
async def test_relayed_payout_goes_to_the_chains_relay_spend(monkeypatch, db_session):
    ex = RelayExecutor(db_session)
    monkeypatch.setattr("app.services.v5_chains.executor", lambda chain_id: ex if chain_id == 8453 else None)
    app = _app(monkeypatch, db_session)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await _create_account(client)
        r = await client.post("/v1/payouts", headers={"Idempotency-Key": "p3", "X-Write-Nonce": "once", "X-Write-Signature": "0xsig"},
                              json=_payout(account_id=account["account_id"], submission_mode="relay"))
    assert r.status_code == 200, r.text
    assert r.json()["operation"]["status"] == "submitted"
    [(body, headers)] = ex.calls
    assert body == {"chain_id": 8453, **_bundle()}
    assert headers["X-Write-Nonce"] == "once" and headers["X-Write-Signature"] == "0xsig"
    assert db_session.query(IdempotencyKey).filter_by(status="completed").count() == 2


@pytest.mark.asyncio
async def test_relayer_credit_shortfall_is_a_clear_402(monkeypatch, db_session):
    from app.errors import BadRequest

    ex = RelayExecutor(db_session, error=BadRequest("insufficient_withdraw_credit"))
    monkeypatch.setattr("app.services.v5_chains.executor", lambda _chain_id: ex)
    app = _app(monkeypatch, db_session)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await _create_account(client)
        r = await client.post("/v1/payouts", headers={"Idempotency-Key": "p4"},
                              json=_payout(account_id=account["account_id"], submission_mode="relay"))
    assert r.status_code == 402, r.text
    assert r.json()["error_code"] == "withdraw_credit_required"


@pytest.mark.asyncio
async def test_relay_refuses_to_broadcast_without_idempotency_key(monkeypatch, db_session):
    ex = RelayExecutor(db_session, error=AssertionError("relay must not run without a durable reservation"))
    monkeypatch.setattr("app.services.v5_chains.executor", lambda _chain_id: ex)
    app = _app(monkeypatch, db_session)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await _create_account(client)
        r = await client.post("/v1/payouts", json=_payout(account_id=account["account_id"], submission_mode="relay"))
    assert r.status_code == 400
    assert r.json()["error_code"] == "bad_request"
    assert ex.calls == []
