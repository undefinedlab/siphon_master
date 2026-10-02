"""v5 read routes: chain registry, state leaves, compliance witness, per-wallet fee."""
import fakeredis
import pytest
from fastapi import Request
from httpx import ASGITransport, AsyncClient

from app.deps.api_key import verify_api_key
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox, verify_wallet_sig_or_sandbox
from app.errors import BadRequest
from app.main import create_app

WALLET = "0x1111111111111111111111111111111111111111"


def _app(monkeypatch):
    redis = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: redis)

    def stash_key(request: Request):
        request.state.api_key_id = "k"
        request.state.sandbox = False
        return object()

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = stash_key
    app.dependency_overrides[verify_wallet_sig_or_sandbox] = lambda: WALLET
    app.dependency_overrides[verify_wallet_intent_or_sandbox] = lambda: WALLET
    return app


class FakeIndexer:
    def __init__(self, reply):
        self.reply, self.params = reply, None

    def _request(self, method, path, params=None, **_):
        assert (method, path) == ("GET", "/state/leaves")
        self.params = params
        return self.reply


class FakeAsp:
    def __init__(self, member=True):
        self.member, self.reads, self.verified = member, [], []

    def set_read(self, what, params, caller=None):
        self.reads.append((what, params))
        self.callers = getattr(self, "callers", []) + [caller]
        if what == "path":
            return {"found": False} if not self.member else {"leafIndex": 3, "pathElements": ["7", "8"], "pathIndices": [1, 0]}
        if what == "smt-path":
            return {"pathElements": ["9", "10"], "pathIndices": [0, 1], "claimedLeaf": "0"}
        if what == "root":
            return {"admittedRoot": "111", "revokedRoot": "222"}
        if what == "member":
            return {"admitted": self.member, "revoked": False}

    def fee_check(self, params):
        self.reads.append(("fee", params))
        return {"paid": False, "vault": "0x00000000000000000000000000000000000000fe", "feeWei": 200000000000000}

    def fee_verify(self, body):
        self.verified.append(body)
        raise BadRequest("fee transaction has 1/2 confirmations")


async def _get(app, url, **kw):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        return await c.get(url, **kw)


@pytest.mark.asyncio
async def test_chains_lists_base_and_arbitrum(monkeypatch):
    r = await _get(_app(monkeypatch), "/v1/chains")
    ids = {c["chain_id"]: c for c in r.json()["chains"]}
    assert set(ids) == {8453, 42161, 900002}  # Sepolia is admin-only
    assert ids[42161]["vault_kernel"] == "0x9Bd05D63F48F2d486D45cD549BDb4F635F90348e"


@pytest.mark.asyncio
async def test_state_leaves_proxy_the_chains_indexer(monkeypatch):
    idx = FakeIndexer({"available": True, "fromIndex": 0, "totalCount": 2, "tipRoot": "5", "leaves": ["1", "2"]})
    monkeypatch.setattr("app.routers.v5.indexer", lambda chain_id: idx)
    r = await _get(_app(monkeypatch), "/v1/chains/42161/state-leaves?limit=2")
    assert r.status_code == 200, r.text
    assert r.json() == {"chain_id": 42161, "from_index": 0, "total_count": 2, "tip_root": "5", "leaves": ["1", "2"]}
    assert idx.params == {"chainId": 42161, "fromIndex": 0, "limit": 2}


@pytest.mark.asyncio
async def test_unknown_chain_is_refused(monkeypatch):
    r = await _get(_app(monkeypatch), "/v1/chains/1/state-leaves")
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_compliance_witness_is_the_sdk_shape(monkeypatch):
    asp = FakeAsp()
    monkeypatch.setattr("app.routers.v5.asp", lambda chain_id: asp)
    monkeypatch.setattr("app.routers.v5.uts.hub_roots", lambda chain_id: ("111", "222"))
    r = await _get(_app(monkeypatch), "/v1/chains/8453/compliance/witness?labels=12&labels=34")
    assert r.status_code == 200, r.text
    w = r.json()
    assert (w["admittedRoot"], w["revokedRoot"]) == ("111", "222")
    assert [i["inLabel"] for i in w["inputs"]] == ["12", "34"]
    assert w["inputs"][0] == {"inLabel": "12", "admittedLeafIndex": 3, "admittedPathElements": ["7", "8"],
                              "admittedPathIndices": [1, 0], "revokedSmtPathElements": ["9", "10"],
                              "revokedSmtPathIndices": [0, 1], "revokedSmtLeaf": "0"}


@pytest.mark.asyncio
async def test_unadmitted_label_is_pending_unless_ragequit(monkeypatch):
    asp = FakeAsp(member=False)
    monkeypatch.setattr("app.routers.v5.asp", lambda chain_id: asp)
    monkeypatch.setattr("app.routers.v5.uts.hub_roots", lambda chain_id: ("111", "222"))
    app = _app(monkeypatch)
    r = await _get(app, "/v1/chains/8453/compliance/witness?labels=12")
    assert r.status_code == 409 and r.json()["error_code"] == "compliance_pending"
    r = await _get(app, "/v1/chains/8453/compliance/witness?labels=12&require_admitted=false")
    assert r.status_code == 200
    # Zero paths at the SMT depth, never a short or missing array.
    assert r.json()["inputs"][0]["admittedPathElements"] == ["0", "0"]


@pytest.mark.asyncio
async def test_labels_must_be_field_elements(monkeypatch):
    monkeypatch.setattr("app.routers.v5.asp", lambda chain_id: FakeAsp())
    r = await _get(_app(monkeypatch), "/v1/chains/8453/compliance/witness?labels=../../admin")
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_fee_check_is_for_the_signing_wallet_only(monkeypatch):
    asp = FakeAsp()
    monkeypatch.setattr("app.routers.v5.asp", lambda chain_id: asp)
    r = await _get(_app(monkeypatch), "/v1/compliance-fee?chain_id=42161&wallet=0x2222222222222222222222222222222222222222")
    assert r.status_code == 200, r.text
    assert r.json()["wallet"] == WALLET and r.json()["fee_wei"] == "200000000000000"
    assert asp.reads[-1] == ("fee", {"wallet": WALLET, "chainId": 42161, "product": "kyt_year_v1"})


@pytest.mark.asyncio
async def test_unconfirmed_fee_payment_is_retryable(monkeypatch):
    asp = FakeAsp()
    monkeypatch.setattr("app.routers.v5.asp", lambda chain_id: asp)
    async with AsyncClient(transport=ASGITransport(app=_app(monkeypatch)), base_url="http://test") as c:
        r = await c.post("/v1/compliance-fee/verify", json={"chain_id": 8453, "tx_hash": "0x" + "ab" * 32})
    assert r.status_code == 409 and r.json()["error_code"] == "compliance_pending"
    assert asp.verified[0]["wallet"] == WALLET
