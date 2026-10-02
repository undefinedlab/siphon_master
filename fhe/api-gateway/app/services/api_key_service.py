"""API-key minting, hashing, and resolution.

Keys are high-entropy random strings — stored ONLY as HMAC-SHA256(pepper, key) (D-a: HMAC, not
Argon2 — keys aren't passwords, so the anti-brute-force CPU cost buys nothing and adds latency to
every request). The plaintext is shown exactly once, at mint. Resolution is deny-by-default:
unknown / revoked / expired -> None.
"""
import hashlib
import hmac
import secrets
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.repository.models import ApiKey


def hash_key(raw: str) -> str:
    """HMAC-SHA256 of the raw key under the server pepper (hex)."""
    pepper = get_settings().api_key_pepper.encode()
    return hmac.new(pepper, raw.encode(), hashlib.sha256).hexdigest()


def mint_key(db: Session, integrator_id: str, plan: str, test: bool = False) -> tuple[str, ApiKey]:
    """Create a new API key. Returns (plaintext, row) — the plaintext is shown ONCE and never stored.

    Format: sk_test_* / sk_live_* + 32 random URL-safe bytes.
    """
    prefix = "sk_test_" if test else "sk_live_"
    raw = prefix + secrets.token_urlsafe(32)
    row = ApiKey(key_hash=hash_key(raw), integrator_id=integrator_id, plan=plan)
    db.add(row)
    db.flush()  # populate row.id without forcing the caller's commit boundary
    return raw, row


def _is_active(row: ApiKey) -> bool:
    if row.status != "active":
        return False
    if row.expires_at is not None:
        exp = row.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp <= datetime.now(timezone.utc):
            return False
    return True


def resolve_api_key(db: Session, raw: str) -> ApiKey | None:
    """Resolve a raw key to its active ApiKey row, or None (deny-by-default).

    Looks up by hash (never by plaintext); returns None for unknown / revoked / expired.
    """
    if not raw:
        return None
    row = db.execute(select(ApiKey).where(ApiKey.key_hash == hash_key(raw))).scalar_one_or_none()
    if row is None or not _is_active(row):
        return None
    return row
