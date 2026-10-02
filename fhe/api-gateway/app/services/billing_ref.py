import hmac
import hashlib
from app.config import get_settings

def sign(api_key_id: str) -> str:
    """Generate an HMAC signed billing reference claim for an api_key_id."""
    settings = get_settings()
    key = settings.billing_ref_hmac_key.encode()
    sig = hmac.new(key, api_key_id.encode(), hashlib.sha256).hexdigest()
    return f"{api_key_id}.{sig}"

def verify(claim: str) -> str | None:
    """Verify an HMAC signed billing reference claim and return the api_key_id if valid."""
    if not claim or "." not in claim:
        return None
    try:
        api_key_id, sig = claim.rsplit(".", 1)
        settings = get_settings()
        key = settings.billing_ref_hmac_key.encode()
        expected_sig = hmac.new(key, api_key_id.encode(), hashlib.sha256).hexdigest()
        if hmac.compare_digest(sig, expected_sig):
            return api_key_id
    except Exception:
        pass
    return None
