"""zkMe client parsing + chain coin mapping."""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

os.environ.setdefault("ASP_DATABASE_URL", "sqlite:///:memory:")

import config
import zkme
from zkme import ZkMeUnavailable, _parse_risk, screen_address


def test_parse_risk_from_data_envelope():
    result = _parse_risk(
        {
            "score": 82,
            "riskLevel": "High",
            "detailList": ["Interact With Malicious Address"],
            "riskDetail": [],
        }
    )
    assert result.decision == "deny"
    assert result.risk_score == 82
    assert result.risk_level == "High"
    assert "zkme_interact_with_malicious_address" in result.reasons


def test_parse_risk_low_score_admits():
    result = _parse_risk({"score": 3, "riskLevel": "Low", "detailList": []})
    assert result.decision == "admit"
    assert result.risk_score == 3
    assert result.risk_level == "Low"


def test_screen_address_uses_chain_specific_coin(monkeypatch):
    monkeypatch.setattr(config, "ZKME_MCH_NO", "mch")
    monkeypatch.setattr(config, "ZKME_API_KEY", "key")
    captured: dict = {}

    def fake_post(endpoint, extra=None):
        captured["endpoint"] = endpoint
        captured["extra"] = extra or {}
        return {"score": 5, "riskLevel": "Low", "detailList": []}

    monkeypatch.setattr(zkme, "_post", fake_post)
    out = screen_address("0xAbC", 8453)
    assert out.decision == "admit"
    assert captured["extra"]["coin"] == "ETH-Base"
    assert captured["extra"]["address"] == "0xabc"


def test_post_rejects_api_error_code(monkeypatch):
    monkeypatch.setattr(config, "ZKME_MCH_NO", "mch")
    monkeypatch.setattr(config, "ZKME_API_KEY", "key")

    mock_resp = MagicMock()
    mock_resp.raise_for_status.return_value = None
    mock_resp.json.return_value = {"code": 80102019, "msg": "Invalid mchNo."}
    with patch("zkme.requests.post", return_value=mock_resp):
        with pytest.raises(ZkMeUnavailable, match="Invalid mchNo"):
            zkme._post(zkme._ZKME_STATUS_ENDPOINT)
