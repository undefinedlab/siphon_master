"""RFC 7807 error handling — problem+json, request_id, no internal leakage."""
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.errors import Sanctioned, install_error_handlers
from app.logging_config import install_request_id_middleware


def _app_with_failing_route(exc_factory):
    app = FastAPI()
    install_request_id_middleware(app)
    install_error_handlers(app)

    @app.get("/boom")
    async def boom():
        raise exc_factory()

    @app.get("/crash")
    async def crash():
        raise RuntimeError("secret SQL: SELECT * FROM api_keys WHERE key_hash='abc'")

    return app


@pytest.mark.asyncio
async def test_gateway_error_renders_rfc7807_problem():
    app = _app_with_failing_route(lambda: Sanctioned("Recipient is sanctioned."))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/boom")
    assert r.status_code == 451
    assert r.headers["content-type"].startswith("application/problem+json")
    body = r.json()
    assert body["error_code"] == "sanctioned"
    assert body["status"] == 451
    assert body["request_id"]                       # present
    assert r.headers["X-Request-ID"] == body["request_id"]
    # no internals leak
    text = r.text.lower()
    assert "traceback" not in text and "sql" not in text


@pytest.mark.asyncio
async def test_unhandled_exception_is_generic_500_no_leak():
    app = _app_with_failing_route(lambda: Sanctioned())
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/crash")
    assert r.status_code == 500
    body = r.json()
    assert body["detail"] == "An unexpected error occurred."   # generic
    # the SQL in the exception message must NOT reach the client
    assert "select" not in r.text.lower() and "api_keys" not in r.text
