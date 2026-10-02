"""Faucet unit tests — reject mainnet, validate pubkey, parse successful RPC."""

from __future__ import annotations

import io
import json
from unittest.mock import MagicMock, patch

import pytest

import solana_faucet as faucet


def test_faucet_rejects_mainnet(monkeypatch):
    monkeypatch.setattr(faucet, "SOLANA_NETWORK", "mainnet-beta")
    with pytest.raises(ValueError, match="mainnet"):
        faucet.request_sol_airdrop("11111111111111111111111111111111", 1_000_000)


def test_faucet_requires_pubkey():
    with pytest.raises(ValueError, match="pubkey"):
        faucet.request_sol_airdrop("", 1_000_000)


def test_faucet_parses_successful_devnet_airdrop(monkeypatch):
    monkeypatch.setattr(faucet, "SOLANA_NETWORK", "devnet")
    monkeypatch.setattr(faucet, "SOLANA_RPC_URL", "https://api.devnet.solana.com")
    fake = {
        "jsonrpc": "2.0",
        "id": 1,
        "result": "5" * 64,
    }
    mock_resp = MagicMock()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.read.return_value = json.dumps(fake).encode()
    # urlopen returns a context manager; json.load reads .read() — use io.BytesIO via wrap
    class _CM:
        def __enter__(self):
            return io.BytesIO(json.dumps(fake).encode())

        def __exit__(self, *a):
            return False

    with patch("urllib.request.urlopen", return_value=_CM()):
        out = faucet.request_sol_airdrop("D26mckDgFqsZGkZquCPeXNENe2ZQ8aEGHW4RxPuBYm3H", 100_000_000)
    assert out["ok"] is True
    assert out["network"] == "devnet"
    assert out["lamports"] == 100_000_000
    assert out["signature"] == "5" * 64
    assert "explorer.solana.com" in out["explorer"]
