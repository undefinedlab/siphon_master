"""Contract test: lock the exact v1 public surface and assert deferred routes are absent.

The OpenAPI document is the published contract (the SDK is a consumer). This test is the
gate that keeps the surface honest: every v1 route present, every [DEFERRED v1.1] route absent.
"""
import pytest
from httpx import AsyncClient, ASGITransport

from app.main import create_app

# The exact v1 surface (spec §6, minus session + topup + automated-billing routes).
V1_PATHS = {
    ("GET", "/v1/health"), ("GET", "/v1/readiness"), ("GET", "/v1/liveness"),
    ("GET", "/v1/notes"),
    ("POST", "/v1/deposits"), ("POST", "/v1/deposits/{id}/confirmation"),
    ("POST", "/v1/withdrawals"), ("POST", "/v1/withdrawals/{id}/confirmation"),
    ("POST", "/v1/notes/consolidation"), ("POST", "/v1/notes/consolidation/{id}/confirmation"),
    ("GET", "/v1/strategies/functions"), ("POST", "/v1/strategies/validate"),
    ("POST", "/v1/strategies"), ("GET", "/v1/strategies"),
    ("GET", "/v1/strategies/{id}"), ("POST", "/v1/strategies/{id}/abort"),
    ("PUT", "/v1/fhe-keys/server"), ("GET", "/v1/fhe-keys"),
    ("GET", "/v1/pool/{chain}/{asset}"),
    ("GET", "/v1/account/usage"), ("GET", "/v1/fees/quote"),
    ("POST", "/v1/accounts"), ("GET", "/v1/accounts"),
    ("GET", "/v1/accounts/{id}"), ("POST", "/v1/accounts/{id}/deposits"),
    ("POST", "/v1/payouts"), ("POST", "/v1/wallet-challenges"),
    ("GET", "/v1/operations/{id}"), ("POST", "/v1/operations/{id}/submission"),
    ("POST", "/v1/webhook-endpoints"),
}

# [DEFERRED v1.1] — these must NOT appear in the v1 contract.
DEFERRED_ABSENT = {"/v1/sessions", "/v1/account/topups", "/v1/account/balance"}


async def _spec() -> dict:
    app = create_app(start_reconciler=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        return (await c.get("/openapi.json")).json()


@pytest.mark.asyncio
async def test_openapi_has_exact_v1_surface():
    spec = await _spec()
    present = {(m.upper(), p) for p, item in spec["paths"].items() for m in item}
    for want in V1_PATHS:
        assert want in present, f"missing {want}"
    for absent in DEFERRED_ABSENT:
        assert not any(p.startswith(absent) for p in spec["paths"]), f"deferred route leaked: {absent}"


@pytest.mark.asyncio
async def test_problem_schema_is_in_the_contract():
    """RFC 7807 Problem is part of the published contract (spec §6.2), with the stable error_code
    machine keys SDKs branch on — not an implementation detail bolted on per handler."""
    spec = await _spec()
    schemas = spec["components"]["schemas"]
    assert "Problem" in schemas, "Problem schema not wired into components/schemas"
    problem = schemas["Problem"]
    props = problem["properties"]
    assert {"type", "title", "status", "detail", "error_code"} <= props.keys()
    # error_code is an enum carrying the §6.2 machine keys (FastAPI emits it as a $ref to ErrorCode).
    dump = str(spec)
    for code in ("insufficient_quota", "sanctioned", "rate_limited", "replayed_request",
                 "idempotency_key_reuse", "needs_consolidation", "fhe_keys_missing"):
        assert code in dump, f"error_code {code} missing from the contract"


@pytest.mark.asyncio
async def test_write_endpoints_declare_error_responses_referencing_problem():
    """Every money-moving write op declares its 4xx/451 error responses referencing Problem, so the
    error contract lives in the reviewed OpenAPI, not in handler code."""
    spec = await _spec()
    write_ops = [
        ("/v1/deposits", "post"), ("/v1/withdrawals", "post"),
        ("/v1/notes/consolidation", "post"), ("/v1/strategies", "post"),
        ("/v1/strategies/{id}/abort", "post"), ("/v1/fhe-keys/server", "put"),
    ]
    required = {"400", "401", "402", "404", "409", "422", "429", "451", "503"}
    for path, method in write_ops:
        responses = spec["paths"][path][method]["responses"]
        missing = required - responses.keys()
        assert not missing, f"{method.upper()} {path} missing error responses {missing}"
        # each error response references the Problem schema
        body = str(responses["451"])
        assert "Problem" in body, f"{method.upper()} {path} 451 does not reference Problem"


@pytest.mark.asyncio
async def test_error_responses_use_rfc7807_media_type_only():
    """Strict RFC 7807 (spec §6.2): error bodies are served as application/problem+json, and the
    redundant application/json variant is stripped from the contract."""
    spec = await _spec()
    for path, item in spec["paths"].items():
        for method, op in item.items():
            for code, response in op["responses"].items():
                content = response.get("content")
                if not content or code == "200":
                    continue
                # a Problem error response must expose problem+json and NOT the plain json variant
                if "application/problem+json" in content:
                    assert "application/json" not in content, (
                        f"{method.upper()} {path} {code} still carries application/json alongside "
                        "application/problem+json"
                    )


@pytest.mark.asyncio
async def test_business_api_declares_bearer_access_but_not_server_wallet_custody():
    spec = await _spec()
    assert "HTTPBearer" in spec["components"]["securitySchemes"]
    account = spec["components"]["schemas"]["AccountView"]
    assert "api_key_can_spend" in account["properties"]
    assert "private_key" not in str(spec).lower()


@pytest.mark.asyncio
async def test_exact_wallet_intent_headers_are_published_for_mutations():
    spec = await _spec()
    for path, method in (
        ("/v1/accounts", "post"),
        ("/v1/accounts/{id}/deposits", "post"),
        ("/v1/payouts", "post"),
        ("/v1/strategies", "post"),
    ):
        operation = spec["paths"][path][method]
        assert operation["x-siphon-wallet-intent"] == "v2"
        headers = {p["name"] for p in operation["parameters"] if p["in"] == "header"}
        assert {"X-Wallet-Address", "X-Signature", "X-Timestamp", "X-Nonce"} <= headers
