"""Loss-safe API-key delivery without plaintext persistence.

The browser keeps a random, wallet-bound delivery key only while a paid purchase is pending. The
gateway stores the minted credential as an AES-GCM envelope in the idempotency record. A retry must
present both a fresh wallet intent and the same delivery key, so neither the database nor the
temporary browser value can recover the credential alone.
"""
import base64
import hashlib
import hmac
import re
import secrets

from Crypto.Cipher import AES

from app.errors import BadRequest

_KEY_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")


def parse_delivery_key(raw: str, expected_sha256: str) -> bytes:
    if not _KEY_RE.fullmatch(raw or ""):
        raise BadRequest("X-Delivery-Key must be a 32-byte 0x-prefixed hex value.")
    key = bytes.fromhex(raw[2:])
    actual = hashlib.sha256(key).hexdigest()
    if not hmac.compare_digest(actual, (expected_sha256 or "").lower()):
        raise BadRequest("X-Delivery-Key does not match delivery_key_sha256.")
    return key


def seal(plaintext: str, key: bytes, *, api_key_id: str) -> str:
    nonce = secrets.token_bytes(12)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    cipher.update(api_key_id.encode("utf-8"))
    ciphertext, tag = cipher.encrypt_and_digest(plaintext.encode("utf-8"))
    return base64.urlsafe_b64encode(nonce + tag + ciphertext).decode("ascii")


def open_envelope(envelope: str, key: bytes, *, api_key_id: str) -> str:
    try:
        packed = base64.urlsafe_b64decode(envelope.encode("ascii"))
        nonce, tag, ciphertext = packed[:12], packed[12:28], packed[28:]
        if len(nonce) != 12 or len(tag) != 16 or not ciphertext:
            raise ValueError("invalid envelope")
        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
        cipher.update(api_key_id.encode("utf-8"))
        return cipher.decrypt_and_verify(ciphertext, tag).decode("utf-8")
    except Exception as exc:
        raise BadRequest("The API-key delivery envelope could not be opened.") from exc
