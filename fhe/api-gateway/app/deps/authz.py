"""Object-level authorization (OWASP API1 BOLA) — the top risk for this API.

The rule (spec §3.5): every resource access verifies the authenticated wallet OWNS the object —
never merely "does it exist". On mismatch we return 404, not 403, so a caller cannot confirm the
existence of an object they don't own. Called in the SERVICE layer, before returning or mutating.
"""
from app.errors import NotFound


def require_owner(resource_owner: str | None, authed_wallet: str) -> None:
    """Raise NotFound unless `authed_wallet` owns the resource (case-insensitive address match)."""
    if resource_owner is None or resource_owner.lower() != authed_wallet.lower():
        raise NotFound("Resource not found.")
