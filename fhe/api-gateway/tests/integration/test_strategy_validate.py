"""GET /v1/strategies/functions (agent discovery) + POST /v1/strategies/validate (free dry-run)."""
import fakeredis
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app
from app.services import strategy_service


@pytest.fixture(autouse=True)
def _active_generation(monkeypatch):
    """Give these tests an active generation.

    The root conftest strips GENERATION_MANIFEST_PATH so policy tests exercise env-based config,
    and nothing then supplies the env — so every strategy call 503'd `vault_generation_unavailable`
    and these assertions never reached the behaviour they exist to check. Production mounts the
    pinned manifest (docker-compose.prod.yml), so this was a harness gap, not a live one. Tests that
    need the generation ABSENT or exit-only set their own values and still win: monkeypatch applies
    in fixture order, then the test body.
    """
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-hard-asp-v1")


def _app(monkeypatch):
    from app.deps import api_key as api_key_dep
    from app.repository.models import ApiKey

    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)
    fake = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")
    app = create_app(start_reconciler=False)
    app.dependency_overrides[api_key_dep.verify_api_key] = lambda: fake
    return app


def test_functions_catalog_lists_the_five_types():
    cat = strategy_service.functions_catalog()
    names = {t["name"] for t in cat["types"]}
    assert names == {"LIMIT_SELL", "LIMIT_BUY", "TWAP", "DCA", "RANGE_GRID"}
    for t in cat["types"]:
        assert "params_schema" in t


def test_validate_flags_missing_bound():
    out = strategy_service.validate({"strategy_type": "LIMIT_SELL", "chain_id": 8453, "amount": 1.0})
    assert out["valid"] is False
    assert any("bound" in e.lower() for e in out["errors"])


def test_validate_accepts_well_formed():
    out = strategy_service.validate({
        "strategy_type": "LIMIT_SELL", "chain_id": 8453, "amount": 1.0,
        "vault_generation_id": "base-hard-asp-v1",
        "encrypted_upper_bound": "0xdead",
    })
    assert out["valid"] is True and out["errors"] == []


@pytest.mark.asyncio
async def test_validate_endpoint_is_not_metered(monkeypatch):
    app = _app(monkeypatch)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/v1/strategies/validate",
                         headers={"Authorization": "Bearer sk_test_x"},
                         json={"strategy_type": "LIMIT_SELL", "chain_id": 8453, "amount": 1.0,
                               "vault_generation_id": "base-hard-asp-v1",
                               "encrypted_upper_bound": "0xdead"})
    assert r.status_code == 200
    assert r.json()["valid"] is True
    # validate never writes a usage_event (free/unmetered) — nothing to assert on the DB here since
    # the handler doesn't touch metering at all; the absence of a metering import is the guarantee.


@pytest.mark.asyncio
async def test_functions_endpoint(monkeypatch):
    app = _app(monkeypatch)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/v1/strategies/functions", headers={"Authorization": "Bearer sk_test_x"})
    assert r.status_code == 200
    assert {t["name"] for t in r.json()["types"]} == {"LIMIT_SELL", "LIMIT_BUY", "TWAP", "DCA", "RANGE_GRID"}
