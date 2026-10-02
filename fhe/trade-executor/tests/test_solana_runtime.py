"""Deep unit tests for solana_runtime spend scaffolding."""
from __future__ import annotations

import os

import pytest

import solana_runtime as sr


def test_is_solana_chain_id():
    assert sr.is_solana_chain_id(900001)
    assert sr.is_solana_chain_id(900002)
    assert sr.is_solana_chain_id("900002")
    assert not sr.is_solana_chain_id(8453)


def test_describe_solana_runtime_artifact():
    desc = sr.describe_solana_runtime()
    assert desc["verifyArtifactId"] == "groth16-bn254-solana-altbn128-v1"
    assert desc["profileId"] == "solana-v1"
    assert desc["runtime"] == "solana-v1"


def test_execute_rejects_wrong_limb_count():
    with pytest.raises(ValueError, match="25"):
        sr.execute_solana_spend(
            public_inputs_hex=["00"] * 24,
            proof_hex="ab" * 128,
            raw_payee="11111111111111111111111111111111",
        )


def test_execute_without_relayer_is_pending(monkeypatch):
    monkeypatch.delenv("SOLANA_RELAYER_KEYPAIR", raising=False)
    result = sr.execute_solana_spend(
        public_inputs_hex=["00"] * 25,
        proof_hex="ab" * 128,
        raw_payee="11111111111111111111111111111111",
    )
    assert result["ok"] is False
    assert result["pending"] is True
    assert "commitMessageHex" in result
    assert "spendMessageHex" in result
    assert result.get("status") != "mined"
    assert "tx_hash" not in result or not result.get("tx_hash")
    assert result["commitPublicInputsIx"]["name"] == "commit_public_inputs"
    assert result["spendIx"]["name"] == "spend"


def test_stub_wrapper_matches(monkeypatch):
    monkeypatch.delenv("SOLANA_RELAYER_KEYPAIR", raising=False)
    a = sr.execute_solana_spend(
        public_inputs_hex=["11"] * 25,
        proof_hex="cd" * 128,
        raw_payee="11111111111111111111111111111111",
    )
    b = sr.execute_solana_spend_stub(
        public_inputs_hex=["11"] * 25,
        proof_hex="cd" * 128,
        raw_payee="11111111111111111111111111111111",
    )
    assert a["pending"] is True and b["pending"] is True
    assert a["commitMessageHex"] == b["commitMessageHex"]
