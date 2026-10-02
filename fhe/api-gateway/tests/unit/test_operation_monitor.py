from datetime import datetime, timezone

from app.repository.models import ApiKey, IdempotencyKey, Operation
from app.schemas.compliance import BusinessOperationState as S
from app.services import operation_monitor, operation_service


def _key(db):
    key = ApiKey(
        id="key-monitor", key_hash="hash", integrator_id="business", plan="test", status="active"
    )
    db.add(key)
    db.flush()
    return key


def test_monitor_rotates_unconfirmed_rows_instead_of_starving_newer_ones(monkeypatch, db_session):
    key = _key(db_session)
    rows = []
    for n in range(2):
        row = operation_service.create(
            db_session,
            api_key_id=key.id,
            kind="deposit",
            chain_id=8453,
            state=S.submitted,
        )
        row.tx_hash = "0x" + str(n + 1) * 64
        rows.append(row)
    db_session.commit()

    checked = []
    monkeypatch.setattr(operation_monitor, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(
        operation_monitor.operation_service,
        "refresh_chain_state",
        lambda _db, operation: checked.append(operation.id) or False,
    )

    assert operation_monitor.run_once(limit=1) == 0
    assert operation_monitor.run_once(limit=1) == 0
    assert set(checked) == {row.id for row in rows}


def test_monitor_recovers_relay_hash_from_executor_outbox(monkeypatch, db_session):
    key = _key(db_session)
    operation = operation_service.create(
        db_session,
        api_key_id=key.id,
        kind="payout",
        chain_id=8453,
        state=S.authorized,
        detail={"relay_id": "a" * 64},
    )
    reservation = IdempotencyKey(
        key="a" * 64, request_hash="body-hash", status="in_progress"
    )
    db_session.add(reservation)
    db_session.commit()

    class Executor:
        def relay_submission(self, relay_id):
            assert relay_id == "a" * 64
            return {"status": "submitted", "tx_hash": "0x" + "ab" * 32}

        def recover_relay_submission(self, relay_id):
            assert relay_id == "a" * 64
            return {"status": "submitted", "tx_hash": "0x" + "ab" * 32}

    monkeypatch.setattr(operation_monitor, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(operation_monitor, "get_executor_client", lambda: Executor())

    assert operation_monitor.run_once() == 1
    assert operation.state == S.submitted.value
    assert operation.tx_hash == "0x" + "ab" * 32
    assert reservation.status == "completed"
    assert reservation.response_body["operation"]["operation_id"] == operation.id


def test_unsigned_authorizations_rotate_without_starving_relay_recovery(monkeypatch, db_session):
    key = _key(db_session)
    unsigned = operation_service.create(
        db_session,
        api_key_id=key.id,
        kind="payout",
        chain_id=8453,
        state=S.authorized,
        detail={"relay_id": None},
    )
    relay = operation_service.create(
        db_session,
        api_key_id=key.id,
        kind="payout",
        chain_id=8453,
        state=S.authorized,
        detail={"relay_id": "b" * 64},
    )
    relay.last_chain_check_at = datetime.now(timezone.utc)
    reservation = IdempotencyKey(
        key="b" * 64, request_hash="body-hash", status="in_progress"
    )
    db_session.add(reservation)
    db_session.commit()

    class Executor:
        def relay_submission(self, _relay_id):
            return {"status": "mined", "tx_hash": "0x" + "cd" * 32}

    monkeypatch.setattr(operation_monitor, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(operation_monitor, "get_executor_client", lambda: Executor())

    operation_monitor.run_once(limit=1)
    assert unsigned.last_chain_check_at is not None
    assert operation_monitor.run_once(limit=1) == 1
    assert db_session.get(Operation, relay.id).state == S.submitted.value
