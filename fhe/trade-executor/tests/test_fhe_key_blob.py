"""The wallet-wrapped ClientKey blob endpoints (/fheKeyBlob).

These import the REAL handlers from app.py rather than re-implementing them. A mirrored copy
would stay green after the owner check or the NOT-NULL guard was deleted from the shipped code,
which is the exact failure this file exists to prevent.

app.py calls init_note_db() at import time, which connects to Supabase. note_db is stubbed in
sys.modules BEFORE the import so the suite never touches a real database; the handlers under
test do not use it.
"""
from __future__ import annotations

import os
import sys
import time
import types

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct


def _install_note_db_stub() -> None:
    if "note_db" in sys.modules:
        return
    stub = types.ModuleType("note_db")
    stub.init_note_db = lambda *a, **k: None

    class _Session:  # pragma: no cover - only reached if a handler touches the note DB
        # app.py teardown calls NoteSession.remove() on every request.
        @staticmethod
        def remove():
            return None

        def query(self, *a, **k):
            raise AssertionError("test touched the note DB")

    stub.NoteSession = _Session

    # Several modules (precommitments, wallet_auth, ...) import assorted model names from
    # note_db at import time. Hand back a placeholder for anything asked for rather than
    # chasing the list, which would drift the moment a new model is added.
    def _any_attr(name):
        if name.startswith("__"):
            raise AttributeError(name)
        return type(name, (), {})

    stub.__getattr__ = _any_attr  # type: ignore[attr-defined]
    sys.modules["note_db"] = stub


@pytest.fixture(scope="module")
def app_mod():
    os.environ.setdefault("DATABASE_URI", "sqlite://")
    os.environ.setdefault("API_TOKEN", "test-token")
    os.environ.setdefault("ENFORCE_WRITE_CHALLENGE", "1")
    _install_note_db_stub()
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import app as A

    A.app.config["TESTING"] = True
    # A private in-memory schema per test module: never touch the deployment's strategies.db.
    A.app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite://"
    with A.app.app_context():
        A.db.drop_all()
        A.db.create_all()
    return A


@pytest.fixture
def client(app_mod):
    with app_mod.app.app_context():
        app_mod.db.drop_all()
        app_mod.db.create_all()
    return app_mod.app.test_client()


def _acct():
    return Account.create()


def _write_headers(acct):
    """Real write-challenge headers: a chain-bound nonce signed as 'Siphon auth v2:write:<chain>:<nonce>'."""
    from challenge_store import issue_challenge
    from wallet_auth import write_message

    nonce = issue_challenge(chain_id=8453)["nonce"]
    sig = Account.sign_message(
        encode_defunct(text=write_message(nonce, 8453)), acct.key
    ).signature.hex()
    return {
        "X-Wallet-Address": acct.address,
        "X-Write-Signature": sig,
        "X-Write-Nonce": nonce,
    }


def _read_headers(acct):
    from wallet_auth import SIGN_MESSAGE

    ts = str(int(time.time()))
    sig = Account.sign_message(
        encode_defunct(text=f"{SIGN_MESSAGE}:{ts}"), acct.key
    ).signature.hex()
    return {
        "X-Wallet-Address": acct.address,
        "X-Signature": sig,
        "X-Timestamp": ts,
    }


def _seed_server_key(app_mod, user_id):
    """A UserFheKey row must pre-exist: server_key is NOT NULL and PUT must not create one."""
    with app_mod.app.app_context():
        app_mod.db.session.add(
            app_mod.UserFheKey(user_id=user_id, server_key="deadbeef")
        )
        app_mod.db.session.commit()


BLOB = {"enc_client_key": "Y2lwaGVydGV4dA==", "client_key_iv": "aXYxMjM0NTY3OA==",
        "client_key_fp": "a" * 16, "client_key_v": 2}


def _upload(client, acct, body):
    return client.post("/uploadServerKey", json={"user_id": acct.address, **body},
                       headers=_write_headers(acct))


def test_blob_rides_the_canary_only_upload(app_mod, client):
    """THE path that matters.

    The browser fast-skips the ~24MB server_key whenever the executor already holds a matching
    fingerprint, so a canary-only POST is the ordinary request. A blob that only persisted
    alongside a full server-key upload would almost never land.
    """
    a = _acct()
    _seed_server_key(app_mod, a.address)
    r = _upload(client, a, {"canary": "0xcafe", **BLOB})
    assert r.status_code == 200, r.get_json()
    with app_mod.app.app_context():
        row = app_mod.UserFheKey.query.get(a.address)
        assert row.enc_client_key == BLOB["enc_client_key"]
        assert row.client_key_iv == BLOB["client_key_iv"]
        assert row.client_key_v == 2
        assert row.canary == "0xcafe"
        assert row.server_key == "deadbeef"  # untouched by a canary-only post


def test_blob_rides_the_full_upload_too(app_mod, client):
    a = _acct()
    r = _upload(client, a, {"server_key": "abc123", "canary": "0xfeed", **BLOB})
    assert r.status_code == 200, r.get_json()
    with app_mod.app.app_context():
        row = app_mod.UserFheKey.query.get(a.address)
        assert row.enc_client_key == BLOB["enc_client_key"]
        assert row.server_key == "abc123"


def test_upload_then_get_round_trips(app_mod, client):
    a = _acct()
    _seed_server_key(app_mod, a.address)
    assert _upload(client, a, {"canary": "0xcafe", **BLOB}).status_code == 200

    g = client.get(f"/fheKeyBlob/{a.address}", headers=_read_headers(a))
    assert g.status_code == 200
    body = g.get_json()
    assert body["enc_client_key"] == BLOB["enc_client_key"]
    assert body["client_key_iv"] == BLOB["client_key_iv"]
    assert body["client_key_v"] == 2


def test_a_blob_only_upload_is_accepted(app_mod, client):
    """No server_key, no canary — just the wrapped key. Still a valid write."""
    a = _acct()
    _seed_server_key(app_mod, a.address)
    assert _upload(client, a, dict(BLOB)).status_code == 200
    with app_mod.app.app_context():
        assert app_mod.UserFheKey.query.get(a.address).enc_client_key == BLOB["enc_client_key"]


def test_an_empty_upload_is_still_rejected(app_mod, client):
    a = _acct()
    _seed_server_key(app_mod, a.address)
    assert _upload(client, a, {}).status_code == 400


def test_a_blob_cannot_create_a_row_without_a_server_key(app_mod, client):
    """server_key is NOT NULL; a first upload must still carry it."""
    a = _acct()  # deliberately NOT seeded
    assert _upload(client, a, dict(BLOB)).status_code == 400
    with app_mod.app.app_context():
        assert app_mod.UserFheKey.query.get(a.address) is None


def test_upload_rejects_a_wallet_that_does_not_own_the_user_id(app_mod, client):
    owner, attacker = _acct(), _acct()
    _seed_server_key(app_mod, owner.address)
    r = client.post("/uploadServerKey", json={"user_id": owner.address, "canary": "x", **BLOB},
                    headers=_write_headers(attacker))
    assert r.status_code == 403
    with app_mod.app.app_context():
        assert app_mod.UserFheKey.query.get(owner.address).enc_client_key is None


def test_upload_bounds_blob_length_in_the_handler(app_mod, client):
    """SQLite ignores VARCHAR(n) and prod IS SQLite, so the handler is the only real bound."""
    a = _acct()
    _seed_server_key(app_mod, a.address)
    r = _upload(client, a, {"canary": "x", "enc_client_key": "A" * (64 * 1024 + 1),
                            "client_key_iv": BLOB["client_key_iv"]})
    assert r.status_code == 400
    with app_mod.app.app_context():
        assert app_mod.UserFheKey.query.get(a.address).enc_client_key is None


def test_get_rejects_a_wallet_that_does_not_own_the_user_id(app_mod, client):
    owner, attacker = _acct(), _acct()
    _seed_server_key(app_mod, owner.address)
    _upload(client, owner, {"canary": "x", **BLOB})
    r = client.get(f"/fheKeyBlob/{owner.address}", headers=_read_headers(attacker))
    assert r.status_code == 403
    assert "enc_client_key" not in (r.get_json() or {})


def test_get_404s_when_there_is_no_blob(app_mod, client):
    a = _acct()
    _seed_server_key(app_mod, a.address)
    r = client.get(f"/fheKeyBlob/{a.address}", headers=_read_headers(a))
    assert r.status_code == 404


def test_get_without_auth_is_rejected(app_mod, client):
    a = _acct()
    _seed_server_key(app_mod, a.address)
    assert client.get(f"/fheKeyBlob/{a.address}").status_code in (401, 403)


def test_there_is_no_standalone_blob_write_route(app_mod):
    """The write rides /uploadServerKey's challenge. A separate PUT would sign a fresh nonce and
    put a wallet popup on the exact flow this work removes one from."""
    rules = {r.rule: r.methods for r in app_mod.app.url_map.iter_rules()}
    assert "PUT" not in rules.get("/fheKeyBlob", set())


def test_g8_auth_challenge_endpoint_binds_the_chain(client, monkeypatch):
    """OVERLORD G-8 at the HTTP boundary: /auth/challenge only issues nonces for served chains."""
    monkeypatch.setenv("WRITE_AUTH_CHAIN_IDS", "8453,11155111")
    monkeypatch.setenv("WRITE_CHALLENGE_REQUIRE_CHAIN", "1")
    ok = client.post("/auth/challenge", json={"chain_id": 8453})
    assert ok.status_code == 200 and ok.get_json()["message"].startswith("Siphon auth v2:write:8453:")
    assert client.post("/auth/challenge", json={"chain_id": 42161}).status_code == 400  # Arbitrum's chain
    assert client.post("/auth/challenge").status_code == 400  # unbound, after the flip
