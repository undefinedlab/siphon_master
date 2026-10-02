"""verify_api_key — resolve the Authorization: Bearer key to an active ApiKey, else 401.

Deny-by-default: missing / malformed / unknown / revoked / expired -> 401 unauthorized. The resolved
key id is stashed on request.state so the rate limiter (and metering) can key by it. The raw key is
never logged and never placed on request.state.
"""
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.errors import Unauthorized
from app.repository.models import ApiKey
from app.repository.session import get_db
from app.services.api_key_service import resolve_api_key


_bearer_scheme = HTTPBearer(
    auto_error=False,
    description="Business API key. Grants service access and quota only; never spend authority.",
)


def verify_api_key(
    request: Request,
    db: Session = Depends(get_db),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> ApiKey:
    raw = (
        credentials.credentials.strip()
        if credentials and credentials.scheme.lower() == "bearer"
        else None
    )
    if not raw:
        raise Unauthorized("Missing or malformed API key.")
    row = resolve_api_key(db, raw)
    if row is None:
        raise Unauthorized("Invalid or revoked API key.")
    request.state.api_key_id = row.id  # for the rate limiter + metering (never the raw key)
    # Sandbox is a property of the KEY, never of a client-supplied header — otherwise a caller could
    # opt a production key into fixtures and bypass the chain entirely.
    from app.config import get_settings
    from app.services.sandbox import is_sandbox_key

    request.state.sandbox = bool(get_settings().sandbox_enabled and is_sandbox_key(row.plan))
    # A free Devnet key reaches Solana Devnet (900002) only. Chain-bearing routes check the chain
    # (v5_chains.access / chain_for); the legacy Base-v1 surfaces have no chain to check, so refuse them.
    request.state.devnet_only = row.plan == "devnet"
    if request.state.devnet_only and request.url.path.startswith(_DEVNET_DENIED):
        from app.errors import Forbidden

        raise Forbidden("This is a free Solana Devnet key; this route is not part of the Devnet API.")
    return row


_DEVNET_DENIED = (
    "/v1/notes", "/v1/deposits", "/v1/withdrawals", "/v1/pool", "/v1/managed-accounts", "/v1/batches",
    "/v1/wallet-challenges", "/v1/fees/quote",
)
