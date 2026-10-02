"""OVERLORD G-8: a write signature must only verify on the host it was made for.

PoC: the Arbitrum box (lower assurance) is compromised. When a user asks it for a write challenge,
it fetches a nonce from the BASE executor's public /auth/challenge and hands that over. The user
signs, the box replays the headers to Base, and Base acts as that wallet (abort strategies, swap
the FHE server key, top up credit, …). The fix binds the chain — served by exactly one host — into
the signed text, and clients build that text from the chain THEY intend.
"""
import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from flask import Flask

import wallet_auth
from challenge_store import issue_challenge

USER = Account.create()
_app = Flask(__name__)


def _sign(text: str) -> str:
    return Account.sign_message(encode_defunct(text=text), USER.key).signature.hex()


def _verify(nonce: str, signature: str):
    headers = {"X-Wallet-Address": USER.address, "X-Write-Signature": signature, "X-Write-Nonce": nonce}
    with _app.test_request_context(headers=headers):
        return wallet_auth._check_wallet_write_sig(consume=True)


@pytest.fixture
def base_executor(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)  # in-process store
    monkeypatch.setenv("WRITE_AUTH_CHAIN_IDS", "8453,11155111")
    monkeypatch.setenv("WRITE_CHALLENGE_REQUIRE_CHAIN", "1")


def test_g8_poc_arbitrum_signature_does_not_verify_on_base(base_executor):
    # The compromised box obtains a real Base nonce …
    nonce = wallet_auth.create_challenge_payload(8453)["nonce"]
    # … but the user's client signs for the chain it is talking to: Arbitrum.
    signature = _sign(f"Siphon auth v2:write:42161:{nonce}")
    assert _verify(nonce, signature) is None


def test_g8_base_will_not_issue_a_challenge_for_a_chain_it_does_not_serve(base_executor):
    with pytest.raises(ValueError, match="does not serve chain 42161"):
        wallet_auth.create_challenge_payload(42161)
    for bad in ("42161", "8453abc", True, None.__class__):
        with pytest.raises(ValueError):
            wallet_auth.create_challenge_payload(bad if bad is not None.__class__ else [8453])


def test_g8_chain_bound_signature_verifies_once(base_executor):
    ch = wallet_auth.create_challenge_payload(8453)
    assert ch["chain_id"] == 8453 and ch["message"] == f"Siphon auth v2:write:8453:{ch['nonce']}"
    signature = _sign(ch["message"])
    assert _verify(ch["nonce"], signature) == USER.address.lower()
    assert _verify(ch["nonce"], signature) is None  # single-use, unchanged


def test_g8_unset_served_chains_fail_closed(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("WRITE_AUTH_CHAIN_IDS", raising=False)
    with pytest.raises(ValueError, match="does not serve"):
        wallet_auth.create_challenge_payload(8453)


def test_g8_unbound_v1_challenges_are_refused_by_default(base_executor):
    with pytest.raises(ValueError, match="chain_id is required"):
        wallet_auth.create_challenge_payload(None)
    # A legacy nonce issued before the flip must not verify after it either.
    nonce = issue_challenge()["nonce"]
    assert _verify(nonce, _sign(f"Siphon auth v1:write:{nonce}")) is None


def test_g8_rollout_window_still_accepts_v1(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.setenv("WRITE_CHALLENGE_REQUIRE_CHAIN", "0")
    ch = wallet_auth.create_challenge_payload(None)
    assert ch["message"] == f"Siphon auth v1:write:{ch['nonce']}"
    assert _verify(ch["nonce"], _sign(ch["message"])) == USER.address.lower()
    # … but a v1 signature can never satisfy a chain-bound nonce.
    monkeypatch.setenv("WRITE_AUTH_CHAIN_IDS", "8453")
    bound = wallet_auth.create_challenge_payload(8453)["nonce"]
    assert _verify(bound, _sign(f"Siphon auth v1:write:{bound}")) is None
