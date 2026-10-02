"""Executor generation policy must treat the pinned manifest as the authority."""
import hashlib
import json

import generation_manifest
from vault_generation import _expected_entrypoint, validate_strategy_generation

MANIFEST = {
    "schemaVersion": 1,
    "manifestId": "test",
    "generations": [
        {
            "generationId": "sepolia-hard-asp-v1-20260806",
            "chainId": 11155111,
            "lifecycle": "ACTIVE",
            "entrypoint": "0xB45Ac5aBBa8d282f2F8A2D55CBd13711230Ae0e0",
            "assets": {"ETH": {"vault": "0x6e", "tree": "0x2a"}},
        },
        {
            "generationId": "sepolia-soft-era",
            "chainId": 11155111,
            "lifecycle": "EXIT_ONLY",
            "entrypoint": "0xE5126A49D1bb93957b4B2F63BCB05a1F8EA9e705",
            "assets": {"ETH": {"vault": "0x8b", "tree": "0xc7"}},
        },
    ],
}


def _install(tmp_path, monkeypatch, data=MANIFEST, digest=None):
    raw = json.dumps(data).encode()
    path = tmp_path / "generation-manifest.json"
    path.write_bytes(raw)
    monkeypatch.setenv("GENERATION_MANIFEST_PATH", str(path))
    monkeypatch.setenv("GENERATION_MANIFEST_SHA256", digest or hashlib.sha256(raw).hexdigest())
    for name in (
        "ACTIVE_VAULT_GENERATION_11155111",
        "ACTIVE_VAULT_GENERATION_8453",
        "EXIT_ONLY_VAULT_GENERATIONS",
        "ACTIVE_VAULT_ENTRYPOINT_11155111",
    ):
        monkeypatch.delenv(name, raising=False)
    generation_manifest._cache = None
    generation_manifest._cache_key = None


def test_create_accepts_manifest_active(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch)
    decision = validate_strategy_generation(
        {"from_chain": 11155111, "vault_generation_id": "sepolia-hard-asp-v1-20260806"}
    )
    assert decision["ok"] is True


def test_exit_only_generation_rejected(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch)
    decision = validate_strategy_generation(
        {"from_chain": 11155111, "vault_generation_id": "sepolia-soft-era"}
    )
    assert decision["ok"] is False
    assert decision["code"] == "VAULT_EXIT_ONLY"


def test_base_fails_closed_without_active_generation(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch)
    decision = validate_strategy_generation(
        {"from_chain": 8453, "vault_generation_id": "base-hard-asp-v1"}
    )
    assert decision["ok"] is False
    assert decision["code"] == "VAULT_GENERATION_UNAVAILABLE"


def test_digest_mismatch_denies(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch, digest="0" * 64)
    decision = validate_strategy_generation(
        {"from_chain": 11155111, "vault_generation_id": "sepolia-hard-asp-v1-20260806"}
    )
    assert decision["ok"] is False


def test_env_drift_denies(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch)
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_11155111", "some-other-generation")
    decision = validate_strategy_generation(
        {"from_chain": 11155111, "vault_generation_id": "sepolia-hard-asp-v1-20260806"}
    )
    assert decision["ok"] is False


def test_entrypoint_comes_from_manifest(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch)
    assert _expected_entrypoint(11155111) == "0xb45ac5abba8d282f2f8a2d55cbd13711230ae0e0"


def test_entrypoint_env_drift_denies(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch)
    monkeypatch.setenv("ACTIVE_VAULT_ENTRYPOINT_11155111", "0x" + "ab" * 20)
    assert _expected_entrypoint(11155111) == ""
