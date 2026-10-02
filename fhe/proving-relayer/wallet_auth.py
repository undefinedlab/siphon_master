from functools import wraps
from flask import request, jsonify
from eth_account import Account
from eth_account.messages import encode_defunct
import os
import time

# MUST match trade-executor/wallet_auth.py and the app's walletAuthHeaders.ts. This file
# previously said "Siphon note encryption v1", which is not the message anything signs — so
# _check_wallet_sig could never validate a real signature. It was also never imported, so the
# mismatch went unnoticed; both are fixed together.
SIGN_MESSAGE = "Siphon auth v1"


def _env_flag(name: str, default: str = "1") -> bool:
    return (os.getenv(name, default) or default).strip() == "1"


def enforce_read_sig_max_age() -> bool:
    """Mirror trade-executor/wallet_auth.py — default ON with a 300s window."""
    return _env_flag("ENFORCE_READ_SIG_MAX_AGE", "1")


def read_sig_max_age_seconds() -> int:
    try:
        return max(60, min(int(os.getenv("READ_SIG_MAX_AGE_SECONDS", "300")), 604800))
    except ValueError:
        return 300


def _check_wallet_sig():
    """Returns lowercased wallet address if sig valid, else None."""
    wallet    = (request.headers.get('X-Wallet-Address') or '').lower()
    signature = request.headers.get('X-Signature') or ''
    timestamp = request.headers.get('X-Timestamp') or ''

    if not wallet or not signature or not timestamp:
        return None
    if enforce_read_sig_max_age():
        try:
            ts = int(timestamp)
        except ValueError:
            return None
        if abs(int(time.time()) - ts) > read_sig_max_age_seconds():
            return None

    message = f"{SIGN_MESSAGE}:{timestamp}"
    msg = encode_defunct(text=message)
    try:
        recovered = Account.recover_message(msg, signature=signature).lower()
    except Exception:
        return None
    return recovered if recovered == wallet else None

def verify_wallet_sig(f):
    """Requires valid wallet signature. Injects wallet= kwarg."""
    @wraps(f)
    def decorated(*args, **kwargs):
        wallet = _check_wallet_sig()
        if not wallet:
            return jsonify({"error": "Invalid or missing wallet signature"}), 401
        return f(*args, wallet=wallet, **kwargs)
    return decorated

def require_api_token_or_wallet(f):
    """Accepts either API token (executor) or wallet sig (user).
    Injects wallet= kwarg; None when called via API token."""
    @wraps(f)
    def decorated(*args, **kwargs):
        # Path 1: API token (executor backend)
        token = request.headers.get('X-API-TOKEN') or request.headers.get('Authorization', '').replace('Bearer ', '')
        expected = os.getenv('API_TOKEN', '')
        if expected and token == expected:
            return f(*args, wallet=None, **kwargs)

        # Path 2: Wallet signature (user)
        wallet = _check_wallet_sig()
        if wallet:
            return f(*args, wallet=wallet, **kwargs)

        return jsonify({"error": "Authentication required"}), 401
    return decorated
