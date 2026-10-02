"""§12 step 5 — real responses conform to their declared OpenAPI schema (the SDK is a consumer).

A minimal structural validator (no new dependency): resolves the response `$ref` from
components/schemas and asserts every `required` field is present and no undeclared field appears
(when additionalProperties is not permitted). This catches a handler drifting from its published
contract — the exact break that silently corrupts an SDK client.
"""
import fakeredis
import httpx
import pytest
from fastapi import Request
from httpx import ASGITransport, AsyncClient

from app.main import create_app
from app.deps.api_key import verify_api_key
from app.deps.wallet_sig import verify_wallet_sig
from app.deps.rate_limit import rate_limit
from app.repository.session import get_db
from app.repository.models import ApiKey


def _resolve(spec: dict, node: dict) -> dict:
    if "$ref" in node:
        name = node["$ref"].rsplit("/", 1)[-1]
        return spec["components"]["schemas"][name]
    return node


def assert_conforms(spec: dict, schema_ref: dict, body: dict):
    schema = _resolve(spec, schema_ref)
    props = schema.get("properties", {})
    required = schema.get("required", [])
    for field in required:
        assert field in body, f"missing required field '{field}'"
    # response models are Pydantic (additionalProperties omitted -> closed); no undeclared keys
    if schema.get("additionalProperties") in (None, False):
        extra = set(body) - set(props)
        assert not extra, f"undeclared field(s) in response: {extra}"


def _response_schema_ref(spec: dict, path: str, method: str) -> dict:
    resp = spec["paths"][path][method]["responses"]["200"]
    return resp["content"]["application/json"]["schema"]


def _stash_key(key):
    def _dep(request: Request):
        request.state.api_key_id = key.id
        return key
    return _dep


@pytest.mark.asyncio
async def test_account_usage_response_conforms(monkeypatch, db_session):
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)
    key = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active", balance_minor=1000)
    db_session.add(key)
    db_session.commit()

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = _stash_key(key)
    app.dependency_overrides[get_db] = lambda: db_session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        spec = (await c.get("/openapi.json")).json()
        r_usage = await c.get("/v1/account/usage", headers={"Authorization": "Bearer sk_x"})
        r_quote = await c.get("/v1/fees/quote", headers={"Authorization": "Bearer sk_x"})

    assert r_usage.status_code == 200
    assert_conforms(spec, _response_schema_ref(spec, "/v1/account/usage", "get"), r_usage.json())
    assert r_quote.status_code == 200
    assert_conforms(spec, _response_schema_ref(spec, "/v1/fees/quote", "get"), r_quote.json())


@pytest.mark.asyncio
async def test_strategy_functions_response_conforms(monkeypatch):
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)
    key = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = lambda: key

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        spec = (await c.get("/openapi.json")).json()
        resp = await c.get("/v1/strategies/functions", headers={"Authorization": "Bearer sk_x"})

    assert resp.status_code == 200
    assert_conforms(spec, _response_schema_ref(spec, "/v1/strategies/functions", "get"), resp.json())


@pytest.mark.asyncio
async def test_problem_error_body_conforms(monkeypatch):
    """An error response (401 unauthorized: no wallet header) is a valid RFC 7807 Problem."""
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: r)
    key = ApiKey(id="k1", key_hash="h", integrator_id="i", plan="test", status="active")

    app = create_app(start_reconciler=False)
    # authed API key but NO wallet signature -> the wallet-sig dep should 401
    app.dependency_overrides[verify_api_key] = lambda: key

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        resp = await c.get("/v1/notes", headers={"Authorization": "Bearer sk_x"})

    assert resp.status_code in (401, 422)
    body = resp.json()
    # RFC 7807 Problem shape (spec §6.2): stable machine key + the standard members.
    assert "error_code" in body
    assert {"type", "title", "status"} <= body.keys()
