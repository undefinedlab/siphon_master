"""POST /solana/publish-roots — withdraw's way to close an unpublished compliance root."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("ASP_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ASP_SCREEN_TOKEN", "screen-test-token16")
os.environ.setdefault("ASP_REQUIRE_AUTH", "1")
os.environ.setdefault("ASP_AUTO_PUBLISH_ROOT", "0")
os.environ.setdefault("ASP_REQUIRE_SEEDED_LISTS", "0")

import config
from app import app


@pytest.fixture
def client():
    return app.test_client()


@pytest.fixture(autouse=True)
def screen_token(monkeypatch):
    monkeypatch.setattr(config, "SCREEN_TOKEN", "screen-test-token16")
    monkeypatch.setattr(config, "REQUIRE_AUTH", True)


def _headers() -> dict:
    return {"Authorization": "Bearer screen-test-token16", "Content-Type": "application/json"}


def test_publish_roots_requires_screen_token(client):
    response = client.post("/solana/publish-roots", json={"chainId": 900002})
    assert response.status_code == 401


def test_publish_roots_rejects_an_evm_chain(client):
    response = client.post("/solana/publish-roots", headers=_headers(), json={"chainId": 8453})
    assert response.status_code == 400
    assert response.get_json()["error"] == "not a Solana chainId"


def test_publish_roots_returns_the_postman_result(client, monkeypatch):
    import postman_solana

    monkeypatch.setattr(
        postman_solana,
        "publish",
        lambda: {"skipped": True, "reason": "matches_chain", "admittedRoot": "7"},
    )
    response = client.post("/solana/publish-roots", headers=_headers(), json={"chainId": 900002})
    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert body["publish"]["reason"] == "matches_chain"


def test_publish_roots_failure_is_retryable(client, monkeypatch):
    import postman_solana

    def boom():
        raise RuntimeError("SOLANA_POSTMAN_KEYPAIR required")

    monkeypatch.setattr(postman_solana, "publish", boom)
    response = client.post("/solana/publish-roots", headers=_headers(), json={"chainId": 900002})
    assert response.status_code == 503
    body = response.get_json()
    assert body["ok"] is False
    assert "SOLANA_POSTMAN_KEYPAIR" in body["message"]
