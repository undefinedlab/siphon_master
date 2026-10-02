"""§12 sweep — no response schema across the public surface can serialize secret material.

Spec §9: ZK/TEE/FHE secrets are client-held and must never cross the gateway boundary. This walks
every response model wired into the OpenAPI contract and asserts none declares a field whose name
matches known-secret material (secret, client key, witness, raw ciphertext/iv, plaintext strategy
bounds, a bare nullifier). A schema-level check catches a leak no per-route response happened to hit.
"""
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app

FORBIDDEN_FIELD_SUBSTRINGS = [
    "secret",
    "client_key",
    "clientkey",
    "witness",
    "ciphertext",
    "plaintext",
    "private_key",
    "encrypted_upper_bound",
    "encrypted_lower_bound",
    "server_key",   # the (large) FHE server key is upload-only; never returned
]

# Safe status/fingerprint fields that legitimately reference key NAMES but expose no material:
# e.g. `server_key_present` (a bool) or `*_fingerprint` (a non-reversible digest). §13: the gateway
# only fingerprints keys — it may report presence/fingerprint, never the key bytes.
SAFE_STATUS_SUFFIXES = ("_present", "_fingerprint", "fingerprint")

# Narrow, audited exceptions — "Schema.field" exactly, never a substring or a whole schema.
#
# WebhookCreateResponse.secret: an OUTBOUND signing secret, not inbound key material and not a
# credential against this API. It authenticates our payloads TO the integrator, so the gateway must
# be able to reproduce it and therefore cannot one-way hash it (unlike an API key). It is returned
# exactly once, at create/rotate, and never echoed by any read route — WebhookView, the schema used
# by GET /v1/webhooks, deliberately omits it. Anything added here needs the same written argument.
AUDITED_EXCEPTIONS = {
    "WebhookCreateResponse.secret",
}


async def _spec() -> dict:
    app = create_app(start_reconciler=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        return (await c.get("/openapi.json")).json()


def _response_schema_names(spec: dict) -> set[str]:
    names: set[str] = set()
    for item in spec["paths"].values():
        for op in item.values():
            if not isinstance(op, dict):
                continue
            for code, response in op.get("responses", {}).items():
                if not str(code).startswith("2"):
                    continue
                for media in (response.get("content") or {}).values():
                    ref = media.get("schema", {}).get("$ref")
                    if ref:
                        names.add(ref.rsplit("/", 1)[-1])
    return names


@pytest.mark.asyncio
async def test_no_response_schema_declares_secret_fields():
    spec = await _spec()
    schemas = spec["components"]["schemas"]
    response_schemas = _response_schema_names(spec)
    assert response_schemas, "no response schemas discovered — the walk is broken"

    offenders: list[str] = []
    for name in response_schemas:
        props = schemas.get(name, {}).get("properties", {})
        for field in props:
            low = field.lower()
            if f"{name}.{field}" in AUDITED_EXCEPTIONS:
                continue
            # A presence flag / fingerprint digest names a key but leaks no material — allowed.
            if low.endswith(SAFE_STATUS_SUFFIXES):
                continue
            if any(bad in low for bad in FORBIDDEN_FIELD_SUBSTRINGS):
                offenders.append(f"{name}.{field}")
            # `nullifier` alone is secret; `nullifier_hash`/`nullifierHashes` is the public marker.
            if "nullifier" in low and "hash" not in low:
                offenders.append(f"{name}.{field}")

    assert not offenders, f"response schema leaks secret-shaped field(s): {offenders}"


@pytest.mark.asyncio
async def test_webhook_read_routes_never_echo_the_secret():
    """Guards the exception above: the secret is create/rotate-only, never readable afterwards."""
    spec = await _spec()
    schemas = spec["components"]["schemas"]

    assert "secret" not in schemas["WebhookView"]["properties"]
    assert "secret" not in schemas["WebhookList"]["properties"].get("webhooks", {}).get("items", {}).get("properties", {})

    # GET /v1/webhook-endpoints must resolve to the secret-free schema, not the create response.
    get_webhooks = spec["paths"]["/v1/webhook-endpoints"]["get"]
    ref = get_webhooks["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
    assert ref.endswith("/WebhookList")


@pytest.mark.asyncio
async def test_audited_exceptions_are_all_still_reachable():
    """An exception left behind after its field is gone silently weakens the sweep."""
    spec = await _spec()
    schemas = spec["components"]["schemas"]
    for entry in AUDITED_EXCEPTIONS:
        schema_name, field = entry.rsplit(".", 1)
        assert schema_name in schemas, f"stale exception: {schema_name} no longer exists"
        assert field in schemas[schema_name].get("properties", {}), f"stale exception: {entry}"


@pytest.mark.asyncio
async def test_noteview_response_is_secret_free():
    """The schema most at risk — it wraps stored note rows that DO hold ciphertext/iv."""
    spec = await _spec()
    note = spec["components"]["schemas"]["NoteView"]["properties"]
    assert set(note.keys()) == {"commitment", "nullifier_hash", "chain_id", "asset", "spent"}
    assert "ciphertext" not in note and "iv" not in note
