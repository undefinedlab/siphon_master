import time
import pytest
from unittest.mock import MagicMock
import requests
from siphon_sdk import SiphonClient, SanctionedError, RateLimitedError


def test_note_generation_fails_loud_without_bn254_poseidon():
    # BN254 circom Poseidon isn't available in the Python SDK yet; note-gen must fail loud rather
    # than mint a note with a mismatched commitment the circuit can't reproduce (funds-loss trap).
    client = SiphonClient("https://api.mocked.siphon", "sk_test_123")
    with pytest.raises(NotImplementedError):
        client.notes.generate(11155111, "USDC", "1000000")


def test_happy_path_list_notes(monkeypatch):
    client = SiphonClient(
        "https://api.mocked.siphon",
        "sk_test_123",
        private_key="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    )

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.headers = {"Content-Type": "application/json"}
    mock_resp.json.return_value = {
        "notes": [
            {"commitment": "c1", "nullifier_hash": "nh1", "chain_id": 11155111, "asset": "USDC", "spent": "false"}
        ],
        "spendable_balance_by_asset": {"USDC": "1000000"}
    }

    def mock_request(*args, **kwargs):
        headers = kwargs.get("headers", {})
        assert headers["Authorization"] == "Bearer sk_test_123"
        assert "X-Wallet-Address" in headers
        assert "X-Signature" in headers
        assert "X-Timestamp" in headers
        return mock_resp

    monkeypatch.setattr(requests, "request", mock_request)

    res = client.notes.list(11155111)
    assert len(res["notes"]) == 1
    assert res["spendable_balance_by_asset"]["USDC"] == "1000000"


def test_error_mapping_sanctioned(monkeypatch):
    client = SiphonClient("https://api.mocked.siphon", "sk_test_123")

    mock_resp = MagicMock()
    mock_resp.status_code = 451
    mock_resp.headers = {"Content-Type": "application/problem+json"}
    mock_resp.json.return_value = {
        "type": "https://api.siphon.money/errors/sanctioned",
        "title": "Address is sanctioned",
        "status": 451,
        "detail": "Wallet is sanctioned by OFAC.",
        "error_code": "sanctioned"
    }

    monkeypatch.setattr(requests, "request", lambda *args, **kwargs: mock_resp)

    with pytest.raises(SanctionedError) as exc_info:
        client.deposits.create(11155111, "USDC", "100", "p1")
    assert exc_info.value.status == 451
    assert exc_info.value.error_code == "sanctioned"


def test_retry_on_rate_limit(monkeypatch):
    client = SiphonClient("https://api.mocked.siphon", "sk_test_123")

    mock_429 = MagicMock()
    mock_429.status_code = 429
    mock_429.headers = {"Content-Type": "application/json"}
    mock_429.json.return_value = {
        "title": "Too Many Requests",
        "status": 429,
        "error_code": "rate_limited"
    }

    mock_200 = MagicMock()
    mock_200.status_code = 200
    mock_200.headers = {"Content-Type": "application/json"}
    mock_200.json.return_value = {"status": "success"}

    call_count = 0

    def mock_request(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return mock_429
        return mock_200

    monkeypatch.setattr(requests, "request", mock_request)
    monkeypatch.setattr(time, "sleep", lambda x: None)

    # confirm targets the {id}/confirmation route (deposit_id, tx_hash, chain_id)
    res = client.deposits.confirm("dep_1", "0xhash", 11155111)
    assert res["status"] == "success"
    assert call_count == 2


def test_cursor_pagination():
    client = SiphonClient("https://api.mocked.siphon", "sk_test_123")
    pages = [
        {"items": ["a", "b"], "next_cursor": "page2"},
        {"items": ["c"], "next_cursor": None}
    ]
    page_idx = 0

    def fetch_page(cursor=None):
        nonlocal page_idx
        res = pages[page_idx]
        page_idx += 1
        return res

    collector = list(client.paginate(fetch_page))
    assert collector == ["a", "b", "c"]
    assert page_idx == 2
