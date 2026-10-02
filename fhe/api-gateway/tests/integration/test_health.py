"""Health endpoints — split (liveness / readiness / health), not combined (spec §10)."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app


async def _get(path, overrides=None):
    app = create_app(start_reconciler=False)
    if overrides:
        app.dependency_overrides.update(overrides)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        return await c.get(path)


@pytest.mark.asyncio
async def test_liveness_always_200_no_io():
    r = await _get("/v1/liveness")
    assert r.status_code == 200
    assert r.json() == {"status": "alive"}


@pytest.mark.asyncio
async def test_health_basic():
    r = await _get("/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["version"] == "1.0.0"


@pytest.mark.asyncio
async def test_readiness_200_when_deps_up():
    from app.routers import health as health_router
    r = await _get("/v1/readiness", overrides={health_router.check_dependencies: lambda: None})
    assert r.status_code == 200
    assert r.json()["status"] == "ready"


@pytest.mark.asyncio
async def test_readiness_503_when_a_dep_is_down():
    from app.routers import health as health_router
    from app.errors import DownstreamUnavailable

    def _down():
        raise DownstreamUnavailable("executor unreachable")

    r = await _get("/v1/readiness", overrides={health_router.check_dependencies: _down})
    assert r.status_code == 503
    assert r.json()["error_code"] == "downstream_unavailable"
