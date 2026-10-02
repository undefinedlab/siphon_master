import hashlib

import pytest

from app.errors import BadRequest
from app.services import key_delivery


def test_delivery_envelope_round_trip_and_tamper_rejection():
    key = bytes.fromhex("42" * 32)
    envelope = key_delivery.seal("sk_test_secret", key, api_key_id="key-1")

    assert "sk_test_secret" not in envelope
    assert key_delivery.open_envelope(envelope, key, api_key_id="key-1") == "sk_test_secret"

    tampered = envelope[:-2] + ("AA" if envelope[-2:] != "AA" else "BB")
    with pytest.raises(BadRequest, match="could not be opened"):
        key_delivery.open_envelope(tampered, key, api_key_id="key-1")
    with pytest.raises(BadRequest, match="could not be opened"):
        key_delivery.open_envelope(envelope, key, api_key_id="another-key")


def test_delivery_header_must_match_the_wallet_bound_body_hash():
    raw = "0x" + ("42" * 32)
    digest = hashlib.sha256(bytes.fromhex(raw[2:])).hexdigest()
    assert key_delivery.parse_delivery_key(raw, digest) == bytes.fromhex("42" * 32)

    with pytest.raises(BadRequest, match="does not match"):
        key_delivery.parse_delivery_key(raw, "00" * 32)
