"""Production boot-time fail-closed checks (OVERLORD F-2, F-10)."""
from __future__ import annotations

from app.config import Settings

_DEV_SECRET_MARKERS: dict[str, str] = {
    "api_key_pepper": "dev-pepper-change-me",
    "billing_ref_hmac_key": "dev-billing-ref-change-me",
    "receipt_signing_key": "dev-receipt-signing-change-me",
}


def is_production_env(siphon_env: str) -> bool:
    return (siphon_env or "").strip().lower() in {"prod", "production"}


def validate_production_boot(settings: Settings) -> None:
    """Abort startup when production is misconfigured."""
    if not is_production_env(settings.siphon_env):
        return

    url = (settings.redis_url or "").strip()
    if url.startswith("memory://") or url.lower() in {"fake", "fakeredis"}:
        raise RuntimeError(
            "REDIS_URL=memory:// is not allowed when SIPHON_ENV/APP_ENV is production"
        )

    for field, marker in _DEV_SECRET_MARKERS.items():
        if getattr(settings, field, "") == marker:
            raise RuntimeError(
                f"{field} is still the dev default; set a production secret when "
                "SIPHON_ENV/APP_ENV is production"
            )
