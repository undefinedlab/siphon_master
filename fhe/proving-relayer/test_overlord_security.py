"""OVERLORD security regression blockers for proving-relayer (F-14…F-16)."""
from __future__ import annotations

import time

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct

import wallet_auth


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("ENFORCE_READ_SIG_MAX_AGE", raising=False)
    monkeypatch.delenv("READ_SIG_MAX_AGE_SECONDS", raising=False)


def test_f14_read_sig_max_age_enabled_by_default(monkeypatch):
    monkeypatch.delenv("ENFORCE_READ_SIG_MAX_AGE", raising=False)
    assert wallet_auth.enforce_read_sig_max_age() is True
    assert wallet_auth.read_sig_max_age_seconds() == 300


def test_f14_stale_read_signature_rejected(monkeypatch):
    monkeypatch.setenv("ENFORCE_READ_SIG_MAX_AGE", "1")
    monkeypatch.setenv("READ_SIG_MAX_AGE_SECONDS", "300")
    acct = Account.create()
    stale_ts = str(int(time.time()) - 3600)
    message = f"{wallet_auth.SIGN_MESSAGE}:{stale_ts}"
    sig = Account.sign_message(encode_defunct(text=message), acct.key).signature.hex()

    from flask import Flask

    app = Flask(__name__)

    @app.route("/probe")
    def probe():
        from flask import request

        wallet = (request.headers.get("X-Wallet-Address") or "").lower()
        signature = request.headers.get("X-Signature") or ""
        timestamp = request.headers.get("X-Timestamp") or ""
        assert wallet == acct.address.lower()
        assert signature == sig
        assert timestamp == stale_ts
        assert wallet_auth._check_wallet_sig() is None
        return {"ok": True}

    client = app.test_client()
    resp = client.get(
        "/probe",
        headers={
            "X-Wallet-Address": acct.address,
            "X-Signature": sig,
            "X-Timestamp": stale_ts,
        },
    )
    assert resp.status_code == 200


def test_f15_app_uses_explicit_cors_allowlist():
    from pathlib import Path

    text = (Path(__file__).resolve().parent / "app.py").read_text(encoding="utf-8")
    assert "CORS(app)" not in text
    assert "_DEFAULT_CORS_ORIGINS" in text
    assert "_CORS_ORIGINS" in text
    assert r"https://.*\.vercel\.app" not in text


def test_f16_ci_workflow_includes_proving_relayer():
    from pathlib import Path

    ci = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "ci.yml"
    body = ci.read_text(encoding="utf-8")
    assert "proving-relayer-security" in body
    assert "proving-relayer" in body
