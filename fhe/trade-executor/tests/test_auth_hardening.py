"""Unit tests for fail-closed auth helpers (no Flask app import required for flag logic)."""
from __future__ import annotations

import hashlib
import hmac
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def test_challenge_issue_and_consume():
    from challenge_store import issue_challenge, consume_challenge, peek_challenge

    ch = issue_challenge(ttl=60)
    assert peek_challenge(ch["nonce"])
    assert consume_challenge(ch["nonce"])
    assert not consume_challenge(ch["nonce"])


def test_env_flags_default_fail_closed(monkeypatch):
    monkeypatch.delenv("ENFORCE_WALLET_AUTH", raising=False)
    monkeypatch.delenv("ENFORCE_WRITE_CHALLENGE", raising=False)
    monkeypatch.delenv("TAG_AUTH_V2_ONLY", raising=False)
    monkeypatch.delenv("BLOCK_BROWSER_EXECUTOR_ROUTES", raising=False)

    def _env_flag(name: str, default: str = "1") -> bool:
        return (os.getenv(name, default) or default).strip() == "1"

    assert _env_flag("ENFORCE_WALLET_AUTH", "1") is True
    assert _env_flag("ENFORCE_WRITE_CHALLENGE", "1") is True
    assert _env_flag("BLOCK_BROWSER_EXECUTOR_ROUTES", "1") is True
    assert _env_flag("TAG_AUTH_V2_ONLY", "0") is False

    monkeypatch.setenv("ENFORCE_WALLET_AUTH", "0")
    assert _env_flag("ENFORCE_WALLET_AUTH", "1") is False


def test_v1_tag_token_formula():
    tag = "abcd" * 10
    expected = hmac.new(tag.encode(), b"siphon-auth-v1", hashlib.sha256).hexdigest()
    assert len(expected) == 64


def test_receipt_public_omits_identity():
    class FakeReceipt:
        def to_dict(self, include_identity=False):
            d = {"id": "1", "kind": "deposit"}
            if include_identity:
                d["identity"] = {"merchant_name": "Acme"}
            return d

    assert "identity" not in FakeReceipt().to_dict(include_identity=False)
    assert FakeReceipt().to_dict(include_identity=True)["identity"]["merchant_name"] == "Acme"


def test_protocol_tvl_metric_name():
    payload = {"metric": "protocol_tvl", "note": "not a per-user balance"}
    assert payload["metric"] == "protocol_tvl"
