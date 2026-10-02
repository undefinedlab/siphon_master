"""Reusable OpenAPI error-response declarations (RFC 7807 Problem).

Every operation declares its possible errors so the error contract lives in the reviewed OpenAPI
document, not in handler code. `responses=` on a route merges these in; all reference the shared
`Problem` schema (with its stable `error_code` machine keys, spec §6.2), so `components/schemas`
carries Problem exactly once.

Usage in a router:

    from app.schemas.errors_openapi import COMMON_ERRORS, WRITE_ERRORS
    @router.get("/notes", responses=COMMON_ERRORS)
    @router.post("/deposits", responses=WRITE_ERRORS)
"""
from app.schemas.common import Problem

# `model=Problem` makes FastAPI register the Problem schema in components/schemas exactly once and
# emit it under application/json. We also declare the RFC 7807 media type (application/problem+json)
# — the content type the gateway actually returns — pointing at the same shared component via $ref
# (not an inline copy, so the doc stays DRY).
_PROBLEM_REF = {"application/problem+json": {"schema": {"$ref": "#/components/schemas/Problem"}}}


def problem_response(description: str) -> dict:
    """One RFC 7807 error-response entry (references the shared Problem component)."""
    return {"model": Problem, "description": description, "content": _PROBLEM_REF}


# Errors any authenticated endpoint can return.
_BASE = {
    400: problem_response("bad_request — malformed or invalid input."),
    401: problem_response("unauthorized / stale_signature — missing/invalid API key or wallet signature."),
    403: problem_response("forbidden."),
    404: problem_response("not_found — object does not exist or is not owned by the caller (BOLA)."),
    429: problem_response("rate_limited — per-key limit exceeded; honor Retry-After."),
    503: problem_response("downstream_unavailable — an internal service (executor/relayer/indexer) is unreachable."),
}

# Read/GET endpoints: the base set.
COMMON_ERRORS: dict = dict(_BASE)

# Money-moving / write endpoints: base + quota, idempotency, conflict, sanctions.
WRITE_ERRORS: dict = {
    **_BASE,
    402: problem_response("insufficient_quota — monthly quota exceeded."),
    409: problem_response("conflict / replayed_request / needs_consolidation / request_in_progress / "
              "fhe_keys_missing — illegal state transition or replay."),
    422: problem_response("idempotency_key_reuse — same Idempotency-Key with a different body."),
    451: problem_response("sanctioned — the sender or recipient is on a sanctions list (write path fails closed)."),
}
