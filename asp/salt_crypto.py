"""Seal pending-admit userSalt at rest. Never log plaintext."""
from __future__ import annotations

import base64
import hashlib
import logging
import os

from cryptography.fernet import Fernet, InvalidToken

import config

log = logging.getLogger("aspv2.salt_crypto")

_PREFIX = "v1:"


def _fernet() -> Fernet:
    raw = (os.getenv("ASP_PENDING_SALT_KEY") or getattr(config, "PENDING_SALT_KEY", "") or "").strip()
    if not raw:
        if config.PRODUCTION_LOCK:
            raise RuntimeError("ASP_PENDING_SALT_KEY required in production")
        raw = (config.SCREEN_TOKEN or "").strip()
    if not raw:
        raise RuntimeError(
            "ASP_PENDING_SALT_KEY (or ASP_SCREEN_TOKEN in non-prod) required to seal userSalt"
        )
    key = base64.urlsafe_b64encode(hashlib.sha256(raw.encode("utf-8")).digest())
    return Fernet(key)


def seal_user_salt(plain: str) -> str:
    plain = str(plain).strip()
    if not plain or plain == "0":
        raise ValueError("non-zero userSalt required")
    token = _fernet().encrypt(plain.encode("utf-8")).decode("ascii")
    return _PREFIX + token


def open_user_salt(sealed: str) -> str:
    """Decrypt sealed salt. Legacy plaintext only when ASP_ALLOW_LEGACY_PLAINTEXT_SALT=1."""
    if not sealed:
        raise ValueError("empty userSalt")
    if sealed.startswith(_PREFIX):
        try:
            return _fernet().decrypt(sealed[len(_PREFIX) :].encode("ascii")).decode("utf-8")
        except InvalidToken as exc:
            raise ValueError("userSalt decrypt failed") from exc
    if getattr(config, "ALLOW_LEGACY_PLAINTEXT_SALT", False):
        return sealed
    raise ValueError("unsealed userSalt rejected")
