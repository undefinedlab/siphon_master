"""Session-key delegation: message parity with the browser, and the accept/reject matrix.

The GOLDEN vector below was produced by siphon-app/src/lib/sessionKey.ts::buildDelegationMessage.
It is the only guard against the trap the module docstring names: the delegation message is
byte-compared during verification, so any drift between the TS and Python builders silently
rejects every session and presents as "sessions are broken" rather than "the two files disagree".
Regenerate it deliberately (and change both builders together) — never edit it to make a test pass.
"""
import json
import time

import pytest
from eth_account import Account
from flask import Flask, jsonify

import session_key
import wallet_auth

GOLDEN_DELEGATION = {
    "sessionAddress": "0xB5351dC951F29E43b60e1ba606781280dAE18165",
    "wallet": "0x9f2fd206cb4fb84e5d37d34801da12ccb537d6d1",
    "chainId": 8453,
    "domain": "siphon.money",
    "issuedAt": 1788364442,
    "expiresAt": 1788450842,
    "nonce": "1aed0c63-6a16-488a-ba1a-d92b88e44618",
}
GOLDEN_MESSAGE = (
    "Siphon session key v1\n"
    "\n"
    "I authorize the session key below to authenticate API requests on my behalf.\n"
    "\n"
    "This does NOT authorize spending, withdrawing, or moving any funds.\n"
    "Moving funds requires a zero-knowledge proof, which this key cannot produce.\n"
    "\n"
    "Session key: 0xB5351dC951F29E43b60e1ba606781280dAE18165\n"
    "Wallet:      0x9f2fd206cb4fb84e5d37d34801da12ccb537d6d1\n"
    "Domain:      siphon.money\n"
    "Chain:       8453\n"
    "Issued:      2026-09-02T15:54:02.000Z\n"
    "Expires:     2026-09-03T15:54:02.000Z\n"
    "Nonce:       1aed0c63-6a16-488a-ba1a-d92b88e44618"
)


def test_message_builder_matches_the_browser():
    assert session_key.build_delegation_message(GOLDEN_DELEGATION) == GOLDEN_MESSAGE


def _mint(*, wallet=None, session=None, domain="siphon.money", chain_id=8453,
          issued_at=None, expires_at=None):
    wallet = wallet or Account.create()
    session = session or Account.create()
    now = int(time.time())
    d = {
        "sessionAddress": session.address,
        "wallet": wallet.address.lower(),
        "chainId": chain_id,
        "domain": domain,
        "issuedAt": now if issued_at is None else issued_at,
        "expiresAt": (now + session_key.SESSION_MAX_AGE_SEC) if expires_at is None else expires_at,
        "nonce": "test-nonce",
    }
    from eth_account.messages import encode_defunct
    d["signature"] = wallet.sign_message(
        encode_defunct(text=session_key.build_delegation_message(d))
    ).signature.hex()
    if not d["signature"].startswith("0x"):
        d["signature"] = "0x" + d["signature"]
    return wallet, session, d


def _auth_headers(wallet, session, delegation, *, signer=None):
    from eth_account.messages import encode_defunct
    ts = str(int(time.time()))
    sig = (signer or session).sign_message(
        encode_defunct(text=f"{wallet_auth.SIGN_MESSAGE}:{ts}")
    ).signature.hex()
    return {
        "X-Wallet-Address": wallet.address.lower(),
        "X-Signature": sig if sig.startswith("0x") else "0x" + sig,
        "X-Timestamp": ts,
        "X-Session-Delegation": json.dumps(delegation),
    }


def test_delegated_signer_is_bound_to_both_key_and_wallet():
    wallet, session, d = _mint()
    raw = json.dumps(d)
    assert session_key.delegated_signer_authorizes(raw, session.address, wallet.address)
    # A delegation is public. Holding one must not be enough — the request signature has to come
    # from the delegated key, and it must name the wallet the request claims to be.
    assert not session_key.delegated_signer_authorizes(raw, Account.create().address, wallet.address)
    assert not session_key.delegated_signer_authorizes(raw, session.address, Account.create().address)
    assert not session_key.delegated_signer_authorizes(None, session.address, wallet.address)


@pytest.mark.parametrize("mutate", [
    # A signature over a DIFFERENT wallet's delegation cannot be re-pointed at this one.
    lambda d: d.update(wallet="0x" + "33" * 20),
    # Self-extended lifetime: the signature is genuine, the claim is not acceptable.
    lambda d: d.update(expiresAt=d["issuedAt"] + 10 * 365 * 24 * 3600),
    lambda d: d.update(expiresAt=d["issuedAt"] - 1),
    lambda d: d.update(issuedAt=int(time.time()) + 3600),
    lambda d: d.update(sessionAddress="0x" + "44" * 20),
])
def test_tampering_is_rejected(mutate):
    _, _, d = _mint()
    mutate(d)
    assert session_key.verify_delegation(json.dumps(d)) is None


def test_garbage_does_not_raise():
    for raw in ("", "{", "null", "[]", '{"wallet":"0x1"}'):
        assert session_key.verify_delegation(raw) is None


def _app():
    app = Flask(__name__)

    @app.route("/read")
    @wallet_auth.verify_wallet_sig
    def read(wallet):
        return jsonify({"wallet": wallet})

    @app.route("/write", methods=["POST"])
    @wallet_auth.verify_wallet_write
    def write(wallet):
        return jsonify({"wallet": wallet})

    return app.test_client()


def test_read_route_accepts_a_session_signed_request():
    wallet, session, d = _mint()
    r = _app().get("/read", headers=_auth_headers(wallet, session, d))
    assert r.status_code == 200
    assert r.get_json()["wallet"] == wallet.address.lower()


def test_read_route_rejects_a_replayed_delegation_signed_by_someone_else():
    wallet, session, d = _mint()
    h = _auth_headers(wallet, session, d, signer=Account.create())
    assert _app().get("/read", headers=h).status_code == 401


def test_read_route_rejects_a_session_signature_with_no_delegation():
    wallet, session, d = _mint()
    h = _auth_headers(wallet, session, d)
    del h["X-Session-Delegation"]
    assert _app().get("/read", headers=h).status_code == 401


def test_a_session_key_cannot_satisfy_the_write_challenge():
    """Fund movement stays on the wallet. ENFORCE_WRITE_CHALLENGE defaults on, and the write
    path never consults the delegation — this is the property the whole design rests on."""
    wallet, session, d = _mint()
    assert _app().post("/write", headers=_auth_headers(wallet, session, d)).status_code == 401


def test_domain_pin_accepts_every_host_the_app_is_served_from(monkeypatch):
    """window.location.host differs between the apex and www, so a single pinned value would
    hard-401 half the users with no client-side fallback."""
    monkeypatch.setattr(session_key, "_EXPECTED_DOMAINS", {"siphon.money", "www.siphon.money"})
    for host in ("siphon.money", "www.siphon.money"):
        _, _, d = _mint(domain=host)
        assert session_key.verify_delegation(json.dumps(d)) is not None
    _, _, d = _mint(domain="evil.example")
    assert session_key.verify_delegation(json.dumps(d)) is None
