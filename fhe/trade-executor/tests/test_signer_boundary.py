"""The signer boundary must fail closed.

Two ways it did not: half-configured remote signing silently reverted to a local private key
(`evm_remote_signing()` is an AND, so dropping one variable flips the mode and signing keeps
working), and RemoteAccount trusted whatever address the CVM signer reported — which is the tx
sender and the withdraw recipient baked into ZK proofs.

Patch module attributes rather than reloading: `importlib.reload(evm_executor)` leaves the
rebuilt module behind for every later test in the same pytest process, which broke
test_zk_proof_shape when this file happened to run first.
"""
import pytest

import evm_executor as m

SIGNER = "https://signer.example"
TOKEN = "t" * 64
ADDR = "0x31C7f4A5a8bF4C0E8a1cBd6B7fD0B1d3D7d6E5F0"
OTHER = "0x0000000000000000000000000000000000000bAd"


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.delenv("BASE_EXECUTOR_ADDRESS", raising=False)
    monkeypatch.delenv("ETH_SEPOLIA_EXECUTOR_ADDRESS", raising=False)
    m.RemoteAccount._addr_cache.clear()
    yield
    m.RemoteAccount._addr_cache.clear()


def signer(monkeypatch, url, token):
    monkeypatch.setattr(m, "EVM_SIGNER_URL", url)
    monkeypatch.setattr(m, "EVM_SIGNER_TOKEN", token)


def test_both_set_is_remote(monkeypatch):
    signer(monkeypatch, SIGNER, TOKEN)
    assert m.evm_remote_signing() is True
    m.assert_signer_config_complete()  # must not raise


def test_neither_set_is_local_on_purpose(monkeypatch):
    signer(monkeypatch, "", "")
    assert m.evm_remote_signing() is False
    m.assert_signer_config_complete()  # explicit local mode is allowed


@pytest.mark.parametrize("url,token,missing", [
    (SIGNER, "", "EVM_SIGNER_TOKEN"),
    ("", TOKEN, "EVM_SIGNER_URL"),
])
def test_half_configured_refuses_to_use_a_local_key(monkeypatch, url, token, missing):
    signer(monkeypatch, url, token)
    with pytest.raises(RuntimeError, match=missing):
        m.assert_signer_config_complete()


class _Res:
    ok = True

    def __init__(self, addr):
        self._addr = addr

    def json(self):
        return {"address": self._addr}


def test_signer_address_matching_the_pin_is_accepted(monkeypatch):
    signer(monkeypatch, SIGNER, TOKEN)
    monkeypatch.setenv("BASE_EXECUTOR_ADDRESS", ADDR)
    monkeypatch.setattr(m.requests, "get", lambda *a, **k: _Res(ADDR))
    assert m.RemoteAccount(8453).address == m.Web3.to_checksum_address(ADDR)


def test_a_signer_reporting_a_different_address_is_refused(monkeypatch):
    # A swapped or spoofed signer would otherwise become the tx sender AND the withdraw recipient.
    signer(monkeypatch, SIGNER, TOKEN)
    monkeypatch.setenv("BASE_EXECUTOR_ADDRESS", ADDR)
    monkeypatch.setattr(m.requests, "get", lambda *a, **k: _Res(OTHER))
    with pytest.raises(RuntimeError, match="Refusing to sign"):
        _ = m.RemoteAccount(8453).address


def test_no_pin_configured_keeps_todays_behaviour(monkeypatch):
    # Production currently leaves BASE_EXECUTOR_ADDRESS empty, so this must stay a no-op until set.
    signer(monkeypatch, SIGNER, TOKEN)
    monkeypatch.setattr(m.requests, "get", lambda *a, **k: _Res(OTHER))
    assert m.RemoteAccount(8453).address == m.Web3.to_checksum_address(OTHER)
