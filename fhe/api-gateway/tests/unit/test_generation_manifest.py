"""The checksum-pinned generation manifest is the authority; env may only agree."""
import hashlib
import json

from app.services import generation_manifest
from app.services.vault_generation import resolve_deposit_generation, validate_strategy_generation

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
    monkeypatch.delenv("ACTIVE_VAULT_GENERATION_11155111", raising=False)
    monkeypatch.delenv("ACTIVE_VAULT_GENERATION_8453", raising=False)
    monkeypatch.delenv("EXIT_ONLY_VAULT_GENERATIONS", raising=False)
    generation_manifest._cache = None
    generation_manifest._cache_key = None


def test_active_resolves_from_manifest(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch)
    decision = resolve_deposit_generation(11155111)
    assert decision["valid"] is True
    assert decision["generation_id"] == "sepolia-hard-asp-v1-20260806"


def test_chain_without_active_generation_fails_closed(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch)
    decision = resolve_deposit_generation(8453)
    assert decision["valid"] is False
    assert decision["code"] == "VAULT_GENERATION_UNAVAILABLE"


def test_digest_mismatch_denies_everything(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch, digest="0" * 64)
    assert resolve_deposit_generation(11155111)["valid"] is False
    result = validate_strategy_generation(11155111, "sepolia-hard-asp-v1-20260806")
    assert result["valid"] is False


def test_env_drift_denies(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch)
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_11155111", "some-other-generation")
    assert resolve_deposit_generation(11155111)["valid"] is False


def test_env_agreement_allows(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch)
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_11155111", "sepolia-hard-asp-v1-20260806")
    assert resolve_deposit_generation(11155111)["valid"] is True


def test_manifest_exit_only_generation_gets_exit_code(tmp_path, monkeypatch):
    _install(tmp_path, monkeypatch)
    result = validate_strategy_generation(11155111, "sepolia-soft-era")
    assert result["valid"] is False
    assert result["code"] == "VAULT_EXIT_ONLY"
