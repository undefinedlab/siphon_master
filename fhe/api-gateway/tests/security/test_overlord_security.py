"""OVERLORD security regression blockers for siphon-fhe (F-1…F-13)."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.boot_guards import is_production_env, validate_production_boot
from app.config import Settings
from app.errors import BadRequest
from app.services.webhook_service import validate_url


REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE = REPO_ROOT / "docker-compose.prod.yml"
REQUIREMENTS = Path(__file__).resolve().parents[2] / "requirements.txt"
EXECUTOR_APP = REPO_ROOT / "trade-executor" / "app.py"
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"


def test_f2_compose_defaults_production_redis_required():
    text = COMPOSE.read_text(encoding="utf-8")
    assert "API_GATEWAY_SIPHON_ENV:-production" in text
    assert "API_GATEWAY_REDIS_URL:?API_GATEWAY_REDIS_URL must be set" in text
    assert "REDIS_URL=${API_GATEWAY_REDIS_URL:-memory://}" not in text


def test_f3_proving_relayer_loopback_bind():
    text = COMPOSE.read_text(encoding="utf-8")
    assert '"127.0.0.1:5010:5010"' in text
    assert re.search(r'^\s*-\s+"5010:5010"\s*$', text, re.MULTILINE) is None


def test_f4_executor_cors_no_vercel_wildcard():
    text = EXECUTOR_APP.read_text(encoding="utf-8")
    assert r"https://.*\.vercel\.app" not in text


def test_f6_ci_workflow_exists():
    assert CI_WORKFLOW.is_file()
    body = CI_WORKFLOW.read_text(encoding="utf-8")
    assert "tests/security" in body
    assert "proving-relayer-security" in body


def test_f10_production_boot_rejects_dev_pepper(monkeypatch):
    monkeypatch.setenv("SIPHON_ENV", "production")
    settings = Settings(
        siphon_env="production",
        redis_url="redis://localhost:6379/0",
        api_key_pepper="dev-pepper-change-me",
    )
    with pytest.raises(RuntimeError, match="api_key_pepper"):
        validate_production_boot(settings)


def test_f10_production_boot_rejects_memory_redis(monkeypatch):
    settings = Settings(
        siphon_env="production",
        redis_url="memory://",
        api_key_pepper="prod-pepper-secret",
        billing_ref_hmac_key="prod-billing",
        receipt_signing_key="prod-receipt",
    )
    with pytest.raises(RuntimeError, match="memory://"):
        validate_production_boot(settings)


def test_f11_requirements_pinned_exact_versions():
    lines = [
        ln.strip()
        for ln in REQUIREMENTS.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]
    assert lines, "requirements.txt must list dependencies"
    for ln in lines:
        if "==" not in ln:
            continue
        _name, version = ln.split("==", 1)
        assert ".*" not in version, f"unpinned wildcard in {ln}"


def test_f12_webhook_blocks_metadata_even_in_dev(monkeypatch):
    monkeypatch.setenv("SIPHON_ENV", "dev")
    with pytest.raises(BadRequest, match="non-public"):
        validate_url("http://169.254.169.254/latest/meta-data/")


def test_f13_compose_decryptor_url_and_token_required():
    text = COMPOSE.read_text(encoding="utf-8")
    assert "DECRYPTOR_URL=${DECRYPTOR_URL:?DECRYPTOR_URL must be set}" in text
    assert "DECRYPTOR_AUTH_TOKEN=${DECRYPTOR_AUTH_TOKEN:?DECRYPTOR_AUTH_TOKEN must be set}" in text
    assert "35.200.184.7" not in text


def test_f2_is_production_env_helper():
    assert is_production_env("production")
    assert is_production_env("prod")
    assert not is_production_env("dev")
