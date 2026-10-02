"""Platform surface: operations, webhooks, subaccounts, receipts, batches, policy.

These target the properties that would be security or billing bugs if wrong — illegal state
transitions, cross-tenant reads, signature forgery, fail-closed policy, spend caps — rather than
re-asserting that a getter returns what a setter stored.
"""
import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.errors import Conflict, Forbidden, InsufficientQuota, NotFound
from app.repository.models import ApiKey, Base, Operation, WebhookEndpoint
from app.schemas.compliance import BusinessOperationState as S
from app.services import (
    batch_service,
    compliance_receipt_service as receipts,
    credit_service,
    operation_service,
    policy_service,
    sandbox,
    subaccount_service,
    webhook_service,
)


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    yield session
    session.close()


def _funded_key(db, key_hash: str, integrator: str, opening: int = 1_000_000) -> ApiKey:
    """Seed the opening balance THROUGH the ledger.

    Setting `balance_minor` directly would create exactly the cache-vs-ledger drift that
    `credit_service.verify_balance` exists to detect, and every reconciliation assertion below would
    be measuring the fixture's bug rather than the code's behaviour.
    """
    row = ApiKey(key_hash=key_hash, integrator_id=integrator, plan="growth", balance_minor=0)
    db.add(row)
    db.flush()
    credit_service.post_entry(
        db, row, kind="grant", amount_minor=opening, reason="test opening", request_id="fixture"
    )
    db.flush()
    return row


@pytest.fixture()
def key(db):
    return _funded_key(db, "h1", "0xint")


@pytest.fixture()
def other_key(db):
    return _funded_key(db, "h2", "0xother")


# ---------------------------------------------------------------------------
# Operations — state machine
# ---------------------------------------------------------------------------


def test_illegal_transition_rejected(db, key):
    op = operation_service.create(db, api_key_id=key.id, kind="withdrawal")
    with pytest.raises(Conflict):
        operation_service.transition(db, op, S.confirmed, emit=False)  # created -> confirmed


def test_terminal_state_is_terminal(db, key):
    op = operation_service.create(db, api_key_id=key.id, kind="withdrawal")
    for st in (S.ready, S.authorized, S.submitted, S.confirmed):
        operation_service.transition(db, op, st, emit=False)
    with pytest.raises(Conflict) as e:
        operation_service.transition(db, op, S.failed, emit=False)
    assert "terminal" in str(e.value).lower()


def test_same_state_transition_is_idempotent(db, key):
    """A retried confirmation must not blow up the record the integrator is polling."""
    op = operation_service.create(db, api_key_id=key.id, kind="withdrawal")
    operation_service.transition(db, op, S.ready, emit=False)
    again = operation_service.transition(db, op, S.ready, tx_hash="0xabc", emit=False)
    assert again.state == S.ready
    assert again.tx_hash == "0xabc"


def test_operation_is_not_readable_cross_tenant(db, key, other_key):
    op = operation_service.create(db, api_key_id=key.id, kind="withdrawal")
    # 404, never 403 — a caller must not learn that someone else's id exists.
    with pytest.raises(NotFound):
        operation_service.get_owned(db, op.id, other_key.id)


def test_list_pagination_is_stable(db, key):
    for _ in range(5):
        operation_service.create(db, api_key_id=key.id, kind="withdrawal")
    page1, cursor = operation_service.list_owned(db, key.id, limit=2)
    assert len(page1) == 2 and cursor
    page2, _ = operation_service.list_owned(db, key.id, limit=2, cursor=cursor)
    assert {o.id for o in page1}.isdisjoint({o.id for o in page2})


# ---------------------------------------------------------------------------
# Webhooks — signing + retry
# ---------------------------------------------------------------------------


def test_signature_roundtrip_and_tamper_detection():
    secret = webhook_service.generate_secret()
    body = json.dumps({"type": "operation.confirmed"}, sort_keys=True, separators=(",", ":"))
    header = webhook_service.sign(secret, body)

    assert webhook_service.verify_signature(secret, body, header)
    assert not webhook_service.verify_signature(secret, body + " ", header)   # tampered body
    assert not webhook_service.verify_signature("whsec_wrong", body, header)  # wrong secret


def test_signature_replay_outside_tolerance_rejected():
    secret = webhook_service.generate_secret()
    body = "{}"
    old = webhook_service.sign(secret, body, timestamp=1_000_000)
    assert not webhook_service.verify_signature(secret, body, old, tolerance_seconds=300)


def test_transition_enqueues_delivery_for_subscribed_endpoint(db, key):
    db.add(WebhookEndpoint(
        api_key_id=key.id, url="https://example.test/hook",
        secret=webhook_service.generate_secret(), events=["operation.ready"],
    ))
    db.flush()

    op = operation_service.create(db, api_key_id=key.id, kind="withdrawal")
    operation_service.transition(db, op, S.ready)

    from app.repository.models import WebhookDelivery
    rows = db.query(WebhookDelivery).all()
    assert len(rows) == 1
    assert rows[0].event_type == "operation.ready"
    assert rows[0].status == "pending"


def test_unsubscribed_event_is_not_delivered(db, key):
    db.add(WebhookEndpoint(
        api_key_id=key.id, url="https://example.test/hook",
        secret=webhook_service.generate_secret(), events=["operation.confirmed"],
    ))
    db.flush()
    op = operation_service.create(db, api_key_id=key.id, kind="withdrawal")
    operation_service.transition(db, op, S.ready)

    from app.repository.models import WebhookDelivery
    assert db.query(WebhookDelivery).count() == 0


def test_backoff_grows_and_caps():
    b = webhook_service._backoff_seconds
    assert b(1) == 60
    assert b(2) == 300
    assert b(1) < b(2) < b(3)
    assert b(20) == 86_400  # capped, never an unbounded wait


def test_delivery_failure_reschedules_then_parks(db, key, monkeypatch):
    from app.repository.models import WebhookDelivery

    ep = WebhookEndpoint(
        api_key_id=key.id, url="https://example.test/hook",
        secret=webhook_service.generate_secret(), events=["*"],
    )
    db.add(ep)
    db.flush()
    d = WebhookDelivery(endpoint_id=ep.id, api_key_id=key.id, event_type="operation.ready", payload={})
    db.add(d)
    db.flush()

    class _Boom:
        def post(self, *a, **k):
            raise RuntimeError("connection refused")

    # Patch the name bound INSIDE webhook_service — it did `from app.config import get_settings` at
    # import time, so patching app.config.get_settings would not be seen here.
    monkeypatch.setattr(
        "app.services.webhook_service.get_settings",
        lambda: _settings_with(webhook_max_attempts=2),
    )

    assert webhook_service.deliver_one(db, d, client=_Boom()) is False
    assert d.status == "pending" and d.attempts == 1 and d.next_attempt_at is not None

    assert webhook_service.deliver_one(db, d, client=_Boom()) is False
    assert d.status == "failed" and d.next_attempt_at is None  # parked, not a hot loop


def _settings_with(**overrides):
    from app.config import Settings

    s = Settings()
    for k, v in overrides.items():
        setattr(s, k, v)
    return s


def test_webhook_url_rejects_non_http():
    from app.errors import BadRequest

    with pytest.raises(BadRequest):
        webhook_service.validate_url("file:///etc/passwd")
    with pytest.raises(BadRequest):
        webhook_service.validate_url("gopher://internal/")


# ---------------------------------------------------------------------------
# Subaccounts — caps derived from the ledger
# ---------------------------------------------------------------------------


def test_spend_cap_enforced_from_ledger(db, key):
    sub = subaccount_service.create(db, api_key_id=key.id, external_id="tenant-1", spend_cap_minor=1_000)

    subaccount_service.charge(db, api_key=key, sub=sub, amount_minor=600, reason="w", request_id="r1")
    assert subaccount_service.spent_minor(db, sub.id) == 600
    assert subaccount_service.remaining_minor(db, sub) == 400

    with pytest.raises(InsufficientQuota):
        subaccount_service.charge(db, api_key=key, sub=sub, amount_minor=500, reason="w", request_id="r2")


def test_in_flight_operations_count_against_the_cap(db, key):
    """The cap must bind BEFORE settlement.

    Authorization only checks the cap while the debit lands at settlement, so if in-flight work did
    not count, `spent` would stay 0 and an unlimited number of batches would each pass the check.
    """
    sub = subaccount_service.create(db, api_key_id=key.id, external_id="t3", spend_cap_minor=500)

    batch_service.create(
        db, api_key_id=key.id, chain_id=8453, asset="USDC", subaccount_id=sub.id,
        items=[{"recipient": "0xa", "amount_minor": 300}],
    )
    assert subaccount_service.spent_minor(db, sub.id) == 0      # nothing settled yet
    assert subaccount_service.reserved_minor(db, sub.id) == 300  # but it is reserved
    assert subaccount_service.remaining_minor(db, sub) == 200

    with pytest.raises(InsufficientQuota):
        subaccount_service.assert_can_spend(db, sub, 300)  # would exceed 500 in aggregate


def test_failed_operation_releases_its_reservation(db, key):
    """A dead operation must not hold budget hostage forever."""
    sub = subaccount_service.create(db, api_key_id=key.id, external_id="t4", spend_cap_minor=500)
    b = batch_service.create(
        db, api_key_id=key.id, chain_id=8453, asset="USDC", subaccount_id=sub.id,
        items=[{"recipient": "0xa", "amount_minor": 400}],
    )
    assert subaccount_service.remaining_minor(db, sub) == 100

    op = batch_service.items(db, b.id)[0]
    operation_service.transition(db, op, S.failed, emit=False)
    assert subaccount_service.reserved_minor(db, sub.id) == 0
    assert subaccount_service.remaining_minor(db, sub) == 500


def test_suspended_subaccount_cannot_spend(db, key):
    sub = subaccount_service.create(db, api_key_id=key.id, external_id="t2")
    sub.status = "suspended"
    db.flush()
    with pytest.raises(Forbidden):
        subaccount_service.assert_can_spend(db, sub, 1)


def test_subaccount_spend_does_not_leak_across_tenants(db, key):
    a = subaccount_service.create(db, api_key_id=key.id, external_id="a", spend_cap_minor=1_000)
    b = subaccount_service.create(db, api_key_id=key.id, external_id="b", spend_cap_minor=1_000)
    subaccount_service.charge(db, api_key=key, sub=a, amount_minor=900, reason="w", request_id="r")

    assert subaccount_service.spent_minor(db, b.id) == 0
    assert subaccount_service.remaining_minor(db, b) == 1_000


def test_duplicate_external_id_rejected(db, key):
    subaccount_service.create(db, api_key_id=key.id, external_id="dup")
    with pytest.raises(Conflict):
        subaccount_service.create(db, api_key_id=key.id, external_id="dup")


def test_subaccount_resolve_is_tenant_scoped(db, key, other_key):
    sub = subaccount_service.create(db, api_key_id=key.id, external_id="mine")
    with pytest.raises(NotFound):
        subaccount_service.resolve(db, other_key.id, sub.id)


# ---------------------------------------------------------------------------
# Compliance receipts
# ---------------------------------------------------------------------------


def test_receipt_verifies_and_detects_tampering(db, key):
    r = receipts.mint(db, api_key_id=key.id, subject_address="0xABC", result="pass", chain_id=8453)
    assert receipts.verify(r)

    exported = receipts.export_view(r)
    assert receipts.verify(exported)

    exported["payload"]["result"] = "deny"  # forge the decision
    assert not receipts.verify(exported)


def test_receipt_excludes_amounts(db, key):
    op = operation_service.create(
        db, api_key_id=key.id, kind="withdrawal", amount_minor=999_999, recipient="0xdead"
    )
    r = receipts.mint(db, api_key_id=key.id, subject_address="0xabc", result="pass", operation_id=op.id)
    body = json.dumps(r.payload)
    assert "999999" not in body and "0xdead" not in body


def test_receipt_is_minted_for_denials_too(db, key):
    r = receipts.mint(db, api_key_id=key.id, subject_address="0xbad", result="deny")
    assert r.result == "deny" and receipts.verify(r)


def test_receipt_not_readable_cross_tenant(db, key, other_key):
    r = receipts.mint(db, api_key_id=key.id, subject_address="0xabc", result="pass")
    with pytest.raises(NotFound):
        receipts.get_owned(db, r.id, other_key.id)


# ---------------------------------------------------------------------------
# Policy — fail-closed
# ---------------------------------------------------------------------------


def test_policy_versions_are_immutable(db, key):
    v1 = policy_service.put(db, api_key_id=key.id, rules={"max_amount_minor": 100})
    v2 = policy_service.put(db, api_key_id=key.id, rules={"max_amount_minor": 200})

    assert v1.version == 1 and v2.version == 2
    assert v1.status == "superseded" and v2.status == "active"
    assert policy_service.get_version(db, key.id, 1).rules == {"max_amount_minor": 100}


def test_unknown_rule_rejected_at_write(db, key):
    from app.errors import BadRequest

    with pytest.raises(BadRequest):
        policy_service.put(db, api_key_id=key.id, rules={"min_anonimity_set": 50})  # typo


def test_min_anonymity_fails_closed_on_unknown_metric(db, key):
    policy_service.put(db, api_key_id=key.id, rules={"min_anonymity_set": 50})
    violations, _ = policy_service.evaluate(db, api_key_id=key.id, anonymity_set=None)
    assert violations and "fail-closed" in violations[0]


def test_stale_asp_root_fails_closed_on_unknown(db, key):
    policy_service.put(db, api_key_id=key.id, rules={"block_on_stale_asp_root": True})
    violations, _ = policy_service.evaluate(db, api_key_id=key.id, asp_root_stale=None)
    assert violations


def test_policy_rules_enforced(db, key):
    policy_service.put(db, api_key_id=key.id, rules={
        "allowed_chains": [8453],
        "allowed_assets": ["USDC"],
        "max_amount_minor": 1_000,
        "recipient_denylist": ["0xBAD"],
    })

    ok, version = policy_service.evaluate(
        db, api_key_id=key.id, chain_id=8453, asset="USDC", amount_minor=500, recipient="0xgood"
    )
    assert ok == [] and version == 1

    bad, _ = policy_service.evaluate(
        db, api_key_id=key.id, chain_id=1, asset="DAI", amount_minor=5_000, recipient="0xbad"
    )
    assert len(bad) == 4  # chain, asset, amount, denylist


def test_no_policy_means_no_constraint(db, key):
    violations, version = policy_service.evaluate(db, api_key_id=key.id, amount_minor=10**12)
    assert violations == [] and version is None


def test_enforce_raises_on_violation(db, key):
    policy_service.put(db, api_key_id=key.id, rules={"max_amount_minor": 10})
    with pytest.raises(policy_service.PolicyViolation):
        policy_service.enforce(db, api_key_id=key.id, amount_minor=11)


# ---------------------------------------------------------------------------
# Batches
# ---------------------------------------------------------------------------


def test_batch_creates_one_operation_per_item(db, key):
    b = batch_service.create(
        db, api_key_id=key.id, chain_id=8453, asset="USDC",
        items=[
            {"recipient": "0xa", "amount_minor": 100},
            {"recipient": "0xb", "amount_minor": 250},
        ],
    )
    assert b.item_count == 2 and b.total_amount_minor == 350
    ops = batch_service.items(db, b.id)
    assert len(ops) == 2
    assert {o.recipient for o in ops} == {"0xa", "0xb"}


def test_batch_rejects_bad_items(db, key):
    from app.errors import BadRequest

    with pytest.raises(BadRequest):
        batch_service.create(db, api_key_id=key.id, chain_id=8453, asset="USDC", items=[])
    with pytest.raises(BadRequest):
        batch_service.create(db, api_key_id=key.id, chain_id=8453, asset="USDC",
                             items=[{"recipient": "0xa", "amount_minor": 0}])
    with pytest.raises(BadRequest):
        batch_service.create(db, api_key_id=key.id, chain_id=8453, asset="USDC",
                             items=[{"amount_minor": 5}])


def test_partial_failure_rolls_up_without_voiding_the_run(db, key):
    b = batch_service.create(
        db, api_key_id=key.id, chain_id=8453, asset="USDC",
        items=[{"recipient": f"0x{i}", "amount_minor": 100} for i in range(3)],
    )
    ops = batch_service.items(db, b.id)

    for op in ops:
        operation_service.transition(db, op, S.ready, emit=False)
        operation_service.transition(db, op, S.authorized, emit=False)
        operation_service.transition(db, op, S.submitted, emit=False)
    operation_service.transition(db, ops[0], S.confirmed, emit=False)
    operation_service.transition(db, ops[1], S.confirmed, emit=False)
    operation_service.transition(db, ops[2], S.failed, emit=False)

    batch_service.refresh_state(db, b)
    assert b.state == "confirmed"  # 2 of 3 landed; the run is not voided
    assert batch_service.counts(db, b.id) == {S.confirmed: 2, S.failed: 1}


def test_all_failed_batch_is_failed_not_confirmed(db, key):
    b = batch_service.create(
        db, api_key_id=key.id, chain_id=8453, asset="USDC",
        items=[{"recipient": "0xa", "amount_minor": 100}],
    )
    op = batch_service.items(db, b.id)[0]
    operation_service.transition(db, op, S.failed, emit=False)
    batch_service.refresh_state(db, b)
    assert b.state == "failed"


def test_batch_not_readable_cross_tenant(db, key, other_key):
    b = batch_service.create(db, api_key_id=key.id, chain_id=8453, asset="USDC",
                             items=[{"recipient": "0xa", "amount_minor": 1}])
    with pytest.raises(NotFound):
        batch_service.get_owned(db, b.id, other_key.id)


# ---------------------------------------------------------------------------
# Sandbox
# ---------------------------------------------------------------------------


def test_sandbox_fixtures_are_deterministic():
    a = sandbox.fake_tx_hash("op1", 8453)
    b = sandbox.fake_tx_hash("op1", 8453)
    assert a == b and a.startswith("0x") and len(a) == 66
    assert sandbox.fake_tx_hash("op2", 8453) != a


def test_sandbox_anonymity_exercises_both_policy_branches(db, key):
    """ETH lands below a typical floor and USDC above it, so an integrator can test pass AND fail."""
    policy_service.put(db, api_key_id=key.id, rules={"min_anonymity_set": 50})

    eth = sandbox.fake_pool_state(8453, "ETH")
    usdc = sandbox.fake_pool_state(8453, "USDC")

    fail, _ = policy_service.evaluate(db, api_key_id=key.id, anonymity_set=eth["anonymity_set"])
    ok, _ = policy_service.evaluate(db, api_key_id=key.id, anonymity_set=usdc["anonymity_set"])
    assert fail and not ok


def test_simulate_header_ignored_for_production_keys():
    """A production key must never be able to induce a failure via X-Simulate."""
    class _Req:
        headers = {"X-Simulate": "sanctioned"}
        state = type("S", (), {"sandbox": False})()

    assert sandbox.apply_scenario(_Req()) is None  # no raise


def test_simulate_header_forces_error_in_sandbox():
    from app.errors import Sanctioned

    class _Req:
        headers = {"X-Simulate": "sanctioned"}
        state = type("S", (), {"sandbox": True})()

    with pytest.raises(Sanctioned):
        sandbox.apply_scenario(_Req())


def test_unknown_simulate_scenario_is_a_clean_error():
    from app.errors import BadRequest

    class _Req:
        headers = {"X-Simulate": "explode"}
        state = type("S", (), {"sandbox": True})()

    with pytest.raises(BadRequest):
        sandbox.apply_scenario(_Req())


def test_is_sandbox_key_is_plan_based():
    assert sandbox.is_sandbox_key("test")
    assert not sandbox.is_sandbox_key("growth")


# ---------------------------------------------------------------------------
# Ledger integration with subaccounts
# ---------------------------------------------------------------------------


def test_key_balance_still_reconciles_with_subaccount_debits(db, key):
    start = credit_service.ledger_balance(db, key.id)
    sub = subaccount_service.create(db, api_key_id=key.id, external_id="t")
    credit_service.grant(db, key.id, 5_000, "topup", "r0")
    subaccount_service.charge(db, api_key=key, sub=sub, amount_minor=1_200, reason="w", request_id="r1")

    cached, ledger = credit_service.verify_balance(db, key.id)
    assert cached == ledger == start + 5_000 - 1_200
