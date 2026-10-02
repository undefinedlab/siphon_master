import pytest
from unittest.mock import MagicMock
from app.services import billing_ref, metering
from app.repository.models import ApiKey, UsageEvent
from app.adapters.executor import ExecutorClient
import httpx


def test_billing_attribution_reconciled(db_session):
    # 1. Seed two API keys in the DB
    key1 = ApiKey(id="k1", key_hash="h1", integrator_id="i1", plan="test", status="active")
    key2 = ApiKey(id="k2", key_hash="h2", integrator_id="i2", plan="test", status="active")
    db_session.add(key1)
    db_session.add(key2)
    db_session.commit()

    # 2. Generate a valid signed billing_ref for key1
    ref1 = billing_ref.sign("k1")

    # 3. Simulate four execution events from the executor:
    # Event 1: belongs to k1 (valid billing_ref)
    # Event 2: belongs to k2 but with invalid/malformed billing_ref
    # Event 3: has a valid billing_ref for k1 but is a duplicate of Event 1 (same tx_hash)
    # Event 4: belongs to k2 (valid billing_ref)
    ref2_invalid = "k2.badsignature123"
    ref2_valid = billing_ref.sign("k2")

    mock_events = [
        {"id": "e1", "strategy_id": "s1", "tx_hash": "0xhash1", "billing_ref": ref1, "created_at": "2026-07-21T12:00:00Z"},
        {"id": "e2", "strategy_id": "s2", "tx_hash": "0xhash2", "billing_ref": ref2_invalid, "created_at": "2026-07-21T12:05:00Z"},
        {"id": "e3", "strategy_id": "s3", "tx_hash": "0xhash1", "billing_ref": ref1, "created_at": "2026-07-21T12:10:00Z"},  # duplicate tx_hash
        {"id": "e4", "strategy_id": "s4", "tx_hash": "0xhash3", "billing_ref": ref2_valid, "created_at": "2026-07-21T12:15:00Z"},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/execution-events"
        return httpx.Response(200, json=mock_events)

    executor = ExecutorClient(
        base_url="http://exec:5005",
        api_token="testtoken123",
        transport=httpx.MockTransport(handler)
    )

    # 4. Run reconciliation
    reconciled_count = metering.reconcile(db_session, executor)

    # Assert that:
    # - Only e1 and e4 are reconciled (total 2 new events recorded)
    # - e2 is skipped because of bad signature
    # - e3 is skipped because of duplicate tx_hash (unique constraint check / deduplication)
    assert reconciled_count == 2

    events = db_session.query(UsageEvent).filter_by(event_type="execution").all()
    assert len(events) == 2

    # Map the events by tx_hash
    events_map = {e.tx_hash: e for e in events}
    assert "0xhash1" in events_map
    assert "0xhash3" in events_map

    # Attributions verification
    assert events_map["0xhash1"].api_key_id == "k1"
    assert events_map["0xhash1"].strategy_id == "s1"

    assert events_map["0xhash3"].api_key_id == "k2"
    assert events_map["0xhash3"].strategy_id == "s4"
