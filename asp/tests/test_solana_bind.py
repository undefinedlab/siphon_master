"""ASP Solana depositor bind + chain id helpers."""
from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

os.environ.setdefault("ASP_DATABASE_URL", "sqlite:///:memory:")

import chain_verify
import config
import zkme
from chain_verify import verify_screen_admit_binding
from solana_deposit_verify import verify_solana_deposit
from solana_chain_ids import (
    SOLANA_DEVNET_CHAIN_ID,
    SOLANA_MAINNET_CHAIN_ID,
    is_solana_chain_id,
)
from util import normalize_depositor, normalize_solana_pubkey


def test_solana_chain_ids():
    assert is_solana_chain_id(SOLANA_MAINNET_CHAIN_ID)
    assert is_solana_chain_id(SOLANA_DEVNET_CHAIN_ID)
    assert is_solana_chain_id("900002")
    assert not is_solana_chain_id(8453)


def test_normalize_solana_depositor():
    # System Program id — valid base58 length/charset.
    pk = "11111111111111111111111111111111"
    assert normalize_solana_pubkey(pk) == pk
    assert normalize_depositor(pk, SOLANA_DEVNET_CHAIN_ID) == pk
    assert normalize_depositor("0x" + "ab" * 20, SOLANA_DEVNET_CHAIN_ID) is None
    assert normalize_depositor("0x" + "ab" * 20, 8453) == ("0x" + "ab" * 20)


def test_admit_binding_preserves_solana_depositor_case(monkeypatch):
    pubkey = "Vote111111111111111111111111111111111111111"
    row = SimpleNamespace(
        decision="admit",
        depositor=pubkey,
        chain_id=SOLANA_DEVNET_CHAIN_ID,
        created_at=None,
    )
    monkeypatch.setattr(chain_verify, "get_decision_by_commitment", lambda *_a, **_k: row)
    monkeypatch.setattr(config, "SCREEN_ADMIT_RECHECK", False)

    verify_screen_admit_binding(
        object(),
        commitment="123",
        chain_id=SOLANA_DEVNET_CHAIN_ID,
        tx_hash=None,
        depositor=pubkey,
    )

    try:
        verify_screen_admit_binding(
            object(),
            commitment="123",
            chain_id=SOLANA_DEVNET_CHAIN_ID,
            tx_hash=None,
            depositor=pubkey.lower(),
        )
    except ValueError as exc:
        assert "does not match" in str(exc)
    else:
        raise AssertionError("case-mutated Solana depositor must not bind")


def test_zkme_preserves_solana_pubkey_case(monkeypatch):
    pubkey = "Vote111111111111111111111111111111111111111"
    captured = {}

    def fake_post(_endpoint, payload):
        captured.update(payload)
        return {"score": 0, "riskLevel": "Low"}

    monkeypatch.setattr(zkme, "_post", fake_post)
    zkme.screen_address(pubkey, SOLANA_MAINNET_CHAIN_ID)
    assert captured["address"] == pubkey


def test_solana_deposit_envelope_uses_allowlists(monkeypatch):
    pubkey = "11111111111111111111111111111111"
    monkeypatch.setenv("SOLANA_PROGRAM_ALLOWLIST", pubkey)
    monkeypatch.setenv("VAULT_PDA_ALLOWLIST", pubkey)
    monkeypatch.delenv("SOLANA_RPC_URL", raising=False)

    result = verify_solana_deposit(
        signature="1" * 64,
        program_id=pubkey,
        vault_pda=pubkey,
        commitment=123,
        depositor=pubkey,
    )
    assert result["status"] == "pending_rpc"
    assert result["rpcConfigured"] is False


def test_reject_evm_depositor_on_solana_chain():
    assert normalize_depositor("0x" + "ab" * 20, SOLANA_DEVNET_CHAIN_ID) is None


def test_reject_invalid_base58_depositor():
    assert normalize_solana_pubkey("0OIl") is None
    assert normalize_depositor("not-a-key!!!", SOLANA_DEVNET_CHAIN_ID) is None


def test_verify_solana_deposit_allowlist_miss(monkeypatch):
    pubkey = "11111111111111111111111111111111"
    other = "Vote111111111111111111111111111111111111111"
    monkeypatch.setenv("SOLANA_PROGRAM_ALLOWLIST", pubkey)
    monkeypatch.setenv("VAULT_PDA_ALLOWLIST", pubkey)
    with pytest.raises(ValueError, match="not in SOLANA_PROGRAM_ALLOWLIST"):
        verify_solana_deposit(
            signature="1" * 64,
            program_id=other,
            vault_pda=pubkey,
            commitment=1,
            depositor=pubkey,
        )
