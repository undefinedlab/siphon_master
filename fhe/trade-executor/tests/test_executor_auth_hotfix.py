"""Two routes that moved or authorised funds without a real wallet signature."""
import os
import sys

import pytest

from test_fhe_key_blob import _install_note_db_stub


@pytest.fixture(scope="module")
def client():
    for k, v in {"DATABASE_URI": "sqlite://", "API_TOKEN": "test-token", "ENFORCE_WRITE_CHALLENGE": "1",
                 "DB_ALLOW_DEFAULT_KEY": "1", "NOTE_DB_URI": "postgresql://stub/n",
                 "SERVER_HMAC_SECRET": "test-only"}.items():
        os.environ.setdefault(k, v)
    _install_note_db_stub()
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import app as A

    A.app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite://"
    with A.app.app_context():
        A.db.create_all()
    return A.app.test_client()


def test_float_bridge_route_is_admin_only(client):
    r = client.post("/vault/bridge/execute", json={"from_chain_id": 8453, "to_chain_id": 42161,
                                                   "amount": "1", "asset": "ETH", "recipient": "0x" + "11" * 20})
    assert r.status_code in (401, 503)


def test_solana_open_path_cannot_authorise_relays(client, monkeypatch):
    monkeypatch.setenv("SOLANA_DEVNET_ARM_OPEN", "1")
    r = client.post("/relaySpend", json={"chain_id": 8453},
                    headers={"X-Solana-Address": "8xueCcQRMhKo5CtppfmxXar2LuVaHfiiN3VzhxepqNEg"})
    assert r.status_code == 401


def _session(kp, expires_in=3600, wallet=None):
    """Headers for a Phantom devnet session signed by `kp` (wallet defaults to kp's address)."""
    import base64
    import time

    from wallet_auth import solana_session_message

    wallet = wallet or str(kp.pubkey())
    expires = int(time.time()) + expires_in
    sig = kp.sign_message(solana_session_message(wallet, expires))
    return {"X-Solana-Address": wallet, "X-Solana-Expires": str(expires),
            "X-Solana-Session": base64.b64encode(bytes(sig)).decode()}


def test_solana_reads_need_a_signed_session_for_that_wallet(client, monkeypatch):
    from solders.keypair import Keypair

    monkeypatch.setenv("SOLANA_DEVNET_ARM_OPEN", "1")
    me, other = Keypair(), Keypair()
    me_id = str(me.pubkey())
    assert client.get(f"/hasClientKey/{me_id}", headers=_session(me)).status_code == 200
    # A bare address header — what the old open path accepted — proves nothing.
    assert client.get(f"/hasClientKey/{me_id}", headers={"X-Solana-Address": me_id}).status_code == 401
    assert client.get(f"/hasClientKey/{me_id}", headers=_session(other)).status_code == 401
    assert client.get(f"/hasClientKey/{me_id}", headers=_session(other, wallet=me_id)).status_code == 401
    assert client.get(f"/hasClientKey/{me_id}", headers=_session(me, expires_in=-5)).status_code == 401
    assert client.get(f"/hasClientKey/{me_id}", headers=_session(me, expires_in=3 * 86400)).status_code == 401
    assert client.get("/hasClientKey/0x" + "11" * 20).status_code == 401
    monkeypatch.setenv("SOLANA_DEVNET_ARM_OPEN", "0")
    assert client.get(f"/hasClientKey/{me_id}", headers=_session(me)).status_code == 401


def test_solana_session_reads_cover_only_their_routes(client, monkeypatch):
    from solders.keypair import Keypair

    monkeypatch.setenv("SOLANA_DEVNET_ARM_OPEN", "1")
    me = Keypair()
    me_id = str(me.pubkey())
    assert client.get(f"/strategies/{me_id}", headers=_session(me)).status_code == 200
    assert client.get(f"/fheKeyBlob/{me_id}", headers=_session(me)).status_code == 401  # user data stays gated


def test_solana_session_cannot_write_for_another_user(client, monkeypatch):
    from solders.keypair import Keypair

    monkeypatch.setenv("SOLANA_DEVNET_ARM_OPEN", "1")
    # REQUIRE_USER_API_KEY stays on: Devnet Phantom session must clear the gateway gate itself.
    monkeypatch.delenv("REQUIRE_USER_API_KEY", raising=False)
    monkeypatch.setenv("ENFORCE_WRITE_CHALLENGE", "1")
    me, victim = Keypair(), Keypair()
    r = client.post("/createStrategy", headers=_session(me),
                    json={"user_id": str(victim.pubkey()), "from_chain": "900002"})
    assert r.status_code == 401
    # The same session for its own wallet gets past auth (and fails later, on the empty order).
    r = client.post("/createStrategy", headers=_session(me),
                    json={"user_id": str(me.pubkey()), "from_chain": "900002"})
    assert r.status_code not in (401, 403)


def test_solana_phantom_create_strategy_skips_gateway_api_key(client, monkeypatch):
    from solders.keypair import Keypair

    monkeypatch.setenv("SOLANA_DEVNET_ARM_OPEN", "1")
    monkeypatch.delenv("REQUIRE_USER_API_KEY", raising=False)  # default on
    me = Keypair()
    r = client.post(
        "/createStrategy",
        headers=_session(me),
        json={"user_id": str(me.pubkey()), "from_chain": "900002"},
    )
    # Past the gateway gate — not "must be submitted through the Siphon API gateway".
    assert r.status_code != 403 or "gateway" not in (r.get_json() or {}).get("error", "").lower()
    assert r.status_code not in (401, 403)


def _gateway(wallet, token="test-token"):
    return {"X-Wallet-Address": wallet, "X-Siphon-Gateway-Token": token}


def test_gateway_attested_solana_wallet_reads_its_own_devnet_data(client, monkeypatch):
    from solders.keypair import Keypair

    monkeypatch.setenv("SOLANA_DEVNET_ARM_OPEN", "1")
    me, other = str(Keypair().pubkey()), str(Keypair().pubkey())
    assert client.get(f"/strategies/{me}", headers=_gateway(me)).status_code == 200
    assert client.get(f"/strategies/{me}", headers=_gateway(me, token="forged")).status_code == 401
    assert client.get(f"/strategies/{me}", headers={"X-Wallet-Address": me}).status_code == 401
    assert client.get(f"/strategies/{me}", headers=_gateway(other)).status_code == 401
    # An EVM address never rides the Solana open path, attested or not.
    assert client.get("/strategies/0x" + "11" * 20, headers=_gateway("0x" + "11" * 20)).status_code == 401


def test_gateway_attested_devnet_order_needs_the_wallets_ed25519_intent(client, monkeypatch):
    import base64
    import time

    from solders.keypair import Keypair

    from wallet_auth import _strategy_intent_message

    monkeypatch.setenv("SOLANA_DEVNET_ARM_OPEN", "1")
    monkeypatch.setenv("REQUIRE_USER_API_KEY", "0")
    kp = Keypair()
    me = str(kp.pubkey())
    body = {"from_chain": "900002", "strategy_type": "LIMIT_SELL", "user_id": me, "billing_ref": "b"}
    ts, nonce = str(int(time.time())), "n-1"
    signed = base64.b64encode(bytes(kp.sign_message(_strategy_intent_message(body, ts, nonce).encode()))).decode()
    intent = {"X-Signature": signed, "X-Timestamp": ts, "X-Nonce": nonce}
    r = client.post("/createStrategy", headers={**_gateway(me), **intent}, json=body)
    assert r.status_code not in (401, 403), r.get_json()  # past auth; fails later on the empty order
    forged = base64.b64encode(bytes(Keypair().sign_message(b"x"))).decode()
    r = client.post("/createStrategy", headers={**_gateway(me), **intent, "X-Signature": forged}, json=body)
    assert r.status_code == 401


def test_gateway_attested_solana_wallet_can_relay_but_not_spend_evm(client, monkeypatch):
    from solders.keypair import Keypair

    monkeypatch.setenv("SOLANA_DEVNET_ARM_OPEN", "1")
    me = str(Keypair().pubkey())
    r = client.post("/solana/relayWithdraw", headers=_gateway(me), json={"recipient": me})
    assert r.status_code == 400  # authorised; the empty package is refused
    assert client.post("/relaySpend", headers=_gateway(me), json={"chain_id": 8453}).status_code == 401
