"""OVERLORD security regression blockers for trade-executor (F-5, F-9)."""
from __future__ import annotations

import os
import time

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from flask import Flask, jsonify

import auth
import wallet_auth


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("ENFORCE_READ_SIG_MAX_AGE", raising=False)
    monkeypatch.delenv("READ_SIG_MAX_AGE_SECONDS", raising=False)
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("SIPHON_ENV", raising=False)
    auth._redis = None
    auth._redis_failed = False
    auth.rate_limit_store.clear()


def test_f5_read_sig_max_age_enabled_by_default(monkeypatch):
    monkeypatch.delenv("ENFORCE_READ_SIG_MAX_AGE", raising=False)
    assert wallet_auth.enforce_read_sig_max_age() is True
    assert wallet_auth.read_sig_max_age_seconds() == 300


def test_f5_stale_read_signature_rejected(monkeypatch):
    monkeypatch.setenv("ENFORCE_READ_SIG_MAX_AGE", "1")
    monkeypatch.setenv("READ_SIG_MAX_AGE_SECONDS", "300")
    app = Flask(__name__)

    @app.route("/probe")
    @wallet_auth.verify_wallet_sig
    def probe():
        return jsonify({"ok": True})

    client = app.test_client()
    acct = Account.create()
    stale_ts = str(int(time.time()) - 3600)
    message = f"{wallet_auth.SIGN_MESSAGE}:{stale_ts}"
    sig = Account.sign_message(encode_defunct(text=message), acct.key).signature.hex()
    resp = client.get(
        "/probe",
        headers={
            "X-Wallet-Address": acct.address,
            "X-Signature": sig,
            "X-Timestamp": stale_ts,
        },
    )
    assert resp.status_code == 401


def test_f9_rate_limit_fail_closed_when_redis_required_in_prod(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:6379/0")
    monkeypatch.setenv("SIPHON_ENV", "production")
    auth._redis_failed = True

    app = Flask(__name__)

    @app.route("/limited")
    @auth.rate_limit(max_requests=5, window_seconds=60, bucket="overlord")
    def limited():
        return jsonify({"ok": True})

    client = app.test_client()
    resp = client.get("/limited")
    assert resp.status_code == 503
    assert resp.get_json()["error"] == "Rate limit backend unavailable"
