"""GET /v1/notes — owner-scoped, secret-free (commitments/amounts only, never ciphertext/iv)."""
import fakeredis
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app
from app.services import note_service


class _FakeNote:
    def __init__(self, wallet, commitment, nullifier_hash, chain_id, asset, spent, ciphertext, iv):
        self.wallet = wallet
        self.commitment = commitment
        self.nullifier_hash = nullifier_hash
        self.chain_id = chain_id
        self.asset = asset
        self.spent = spent
        self.ciphertext = ciphertext
        self.iv = iv


def _seed(monkeypatch, rows):
    def _query(wallet):
        return [r for r in rows if r.wallet == wallet.lower()]
    monkeypatch.setattr(note_service, "_fetch_notes", _query)


def test_list_notes_service_whitelists_fields(monkeypatch):
    rows = [
        _FakeNote("0xaaa", "0xc1", "0xn1", 8453, "ETH", "false", "SECRET_CT", "SECRET_IV"),
        _FakeNote("0xaaa", "0xc2", "0xn2", 8453, "ETH", "true", "SECRET_CT2", "SECRET_IV2"),
    ]
    _seed(monkeypatch, rows)
    out = note_service.list_notes("0xAAA")
    dumped = str(out)
    # secrets never present
    assert "SECRET_CT" not in dumped and "SECRET_IV" not in dumped
    # only spendable notes count toward balance
    assert out["spendable_balance_by_asset"] == {}  # amounts not on the whitelist -> count only below
    assert len(out["notes"]) == 2
    for n in out["notes"]:
        assert set(n.keys()) == {"commitment", "nullifier_hash", "chain_id", "asset", "spent"}


@pytest.mark.asyncio
async def test_endpoint_returns_only_authed_wallet_notes(monkeypatch):
    from app.deps import api_key as api_key_dep
    from app.deps import wallet_sig as ws
    from app.repository.models import ApiKey

    rows = [
        _FakeNote("0xaaa", "0xc1", "0xn1", 8453, "ETH", "false", "CT", "IV"),
        _FakeNote("0xbbb", "0xc9", "0xn9", 8453, "ETH", "false", "CT", "IV"),
    ]
    _seed(monkeypatch, rows)

    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)

    fake = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")
    app = create_app(start_reconciler=False)
    app.dependency_overrides[api_key_dep.verify_api_key] = lambda: fake
    app.dependency_overrides[ws.verify_wallet_sig] = lambda: "0xaaa"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        resp = await c.get("/v1/notes", headers={"Authorization": "Bearer sk_test_x"})
    assert resp.status_code == 200
    body = resp.json()
    commitments = {n["commitment"] for n in body["notes"]}
    assert commitments == {"0xc1"}                  # only wallet A's note
    assert "0xc9" not in resp.text                  # wallet B's note absent
    assert "ciphertext" not in resp.text and "iv" not in resp.text
