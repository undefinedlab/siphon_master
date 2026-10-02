from fastapi import Header, HTTPException, Security
from fastapi.security import APIKeyHeader
from app.config import get_settings

admin_token_header = APIKeyHeader(name="X-ADMIN-TOKEN", auto_error=False)

def require_admin_token(
    x_admin_token: str | None = Header(None, alias="X-ADMIN-TOKEN"),
    authorization: str | None = Header(None),
) -> str:
    settings = get_settings()
    expected = (settings.admin_api_token or "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="Admin API is disabled (ADMIN_API_TOKEN is not configured)."
        )

    # Resolve token from headers
    token = x_admin_token
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    if not token or token != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing admin token.")

    return token
