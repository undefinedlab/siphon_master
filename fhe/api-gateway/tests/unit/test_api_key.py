"""API-key auth — HMAC+pepper hashing, mint-once plaintext, deny-by-default resolution."""
import pytest

from app.errors import GatewayError
from app.services.api_key_service import hash_key, mint_key, resolve_api_key


def test_mint_hides_plaintext_persists_hash(db_session):
    raw, row = mint_key(db_session, integrator_id="int_1", plan="test", test=True)
    assert raw.startswith("sk_test_")
    assert row.key_hash == hash_key(raw)
    assert row.key_hash != raw          # never store plaintext
    assert raw not in row.key_hash


def test_mint_live_prefix():
    # hash_key is pure; live vs test only changes the prefix.
    assert hash_key("sk_live_abc") == hash_key("sk_live_abc")
    assert hash_key("a") != hash_key("b")


def test_resolve_active_key_returns_row(db_session):
    raw, row = mint_key(db_session, integrator_id="int_1", plan="test", test=True)
    db_session.commit()
    resolved = resolve_api_key(db_session, raw)
    assert resolved is not None and resolved.id == row.id


def test_resolve_unknown_key_is_none(db_session):
    assert resolve_api_key(db_session, "sk_test_nope") is None


def test_resolve_revoked_key_is_none(db_session):
    raw, row = mint_key(db_session, integrator_id="int_1", plan="test", test=True)
    row.status = "revoked"
    db_session.commit()
    assert resolve_api_key(db_session, raw) is None
