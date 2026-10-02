"""Background chain reconciler for submitted operations.

One designated gateway worker owns this loop (`RUN_OPERATION_MONITOR_IN_WORKER=1`). Confirmed and
failed transitions enqueue webhook events, so delivery does not depend on an integrator polling
`GET /v1/operations/{id}`.
"""
import logging
import threading
from datetime import datetime, timezone

from app.repository.models import IdempotencyKey, Operation
from app.repository.session import SessionLocal
from app.schemas.compliance import BusinessOperationState as S
from app.schemas.business import PayoutResponse
from app.schemas.notes import ConsolidationResponse, WithdrawalResponse
from app.schemas.platform import OperationView
from app.services import operation_service, v5_reconcile
from app.deps.clients import get_executor_client
from app.errors import NotFound

logger = logging.getLogger("siphon.gateway.operation_monitor")


def _complete_relay_recovery(db, operation: Operation, relay_id: str) -> None:
    reservation = db.get(IdempotencyKey, relay_id)
    if reservation is None or reservation.status != "in_progress":
        return
    if operation.state == S.failed.value:
        reservation.status = "completed"
        reservation.status_code = 502
        reservation.response_body = {
            "error_code": operation.error_code or "relay_failed",
            "message": "The executor rejected the relay before a transaction was submitted.",
        }
        return
    if operation.kind == "payout":
        response = PayoutResponse(
            operation=OperationView(**operation_service.public_view(operation)),
            submission_mode="relay",
            transaction=None,
            tx_hash=operation.tx_hash,
        ).model_dump(mode="json")
    elif operation.kind == "withdrawal":
        response = WithdrawalResponse(status="submitted", tx_hash=operation.tx_hash).model_dump()
    elif operation.kind == "consolidation":
        response = ConsolidationResponse(status="submitted", tx_hash=operation.tx_hash).model_dump()
    else:
        return
    reservation.status = "completed"
    reservation.status_code = 200
    reservation.response_body = response


def run_once(*, limit: int = 100) -> int:
    db = SessionLocal()
    try:
        rows = (
            db.query(Operation)
            .filter(
                Operation.state == S.submitted.value,
                Operation.tx_hash.is_not(None),
                Operation.chain_id.is_not(None),
            )
            .order_by(Operation.last_chain_check_at.asc().nullsfirst(), Operation.id.asc())
            .limit(limit)
            .all()
        )
        changed = 0
        for row in rows:
            changed += operation_service.refresh_chain_state(db, row)
            row.last_chain_check_at = datetime.now(timezone.utc)

        # A gateway can die after the executor journals/broadcasts but before it receives the hash.
        # Reconcile those authorized relay operations from the executor's durable outbox.
        relay_rows = (
            db.query(Operation)
            .filter(
                Operation.state == S.authorized.value,
                Operation.kind.in_(("payout", "split", "withdrawal", "consolidation")),
            )
            .order_by(Operation.last_chain_check_at.asc().nullsfirst(), Operation.id.asc())
            .limit(limit)
            .all()
        )
        executor = None
        for row in relay_rows:
            if (row.detail or {}).get("protocol") in ("v5", "solana"):
                # v5 and Solana relays have no executor journal; settle them from the nullifier.
                if (row.detail or {}).get("relay_id"):
                    changed += v5_reconcile.settle_relay(db, row)
                row.last_chain_check_at = datetime.now(timezone.utc)
                continue
            executor = executor or get_executor_client()
            relay_id = (row.detail or {}).get("relay_id")
            if not relay_id:
                # Rotate unsigned payouts out of the limited page; only relay-backed authorized
                # operations need executor recovery.
                row.last_chain_check_at = datetime.now(timezone.utc)
                continue
            try:
                relay = executor.relay_submission(relay_id)
            except NotFound:
                # Absence is never proof that a request queued in another process cannot start.
                # The normal path creates an executor lease before committing this operation; a
                # missing record therefore signals storage inconsistency and needs intervention,
                # not an unsafe terminal transition.
                row.last_chain_check_at = datetime.now(timezone.utc)
                continue
            except Exception:
                row.last_chain_check_at = datetime.now(timezone.utc)
                continue
            if relay.get("tx_hash") and relay.get("status") == "submitted":
                try:
                    relay = executor.recover_relay_submission(relay_id)
                except Exception:
                    row.last_chain_check_at = datetime.now(timezone.utc)
                    continue
            if relay.get("tx_hash"):
                operation_service.transition(db, row, S.submitted, tx_hash=relay["tx_hash"])
                if row.kind in ("withdrawal", "consolidation"):
                    from app.services import tx_binding

                    tx_binding.bind(
                        db,
                        tx_hash=relay["tx_hash"],
                        wallet=row.wallet,
                        api_key_id=row.api_key_id,
                        chain_id=row.chain_id,
                        kind=row.kind,
                    )
                changed += 1
            elif relay.get("status") == "failed":
                operation_service.transition(db, row, S.failed, error_code="relay_failed")
                changed += 1
            if row.state in (S.submitted.value, S.failed.value):
                _complete_relay_recovery(db, row, relay_id)
            row.last_chain_check_at = datetime.now(timezone.utc)
        # Confirmed v5 deposits still waiting for ASP admission (G-1).
        deposit_rows = (
            db.query(Operation)
            .filter(Operation.state == S.confirmed.value, Operation.kind == "deposit")
            .order_by(Operation.last_chain_check_at.asc().nullsfirst(), Operation.id.asc())
            .limit(limit)
            .all()
        )
        for row in deposit_rows:
            if (row.detail or {}).get("admission") == "pending":
                changed += v5_reconcile.admit_deposit(db, row)
                row.last_chain_check_at = datetime.now(timezone.utc)

        db.commit()
        if changed:
            logger.info("operation monitor advanced %d operation(s)", changed)
        return changed
    except Exception:  # noqa: BLE001 — a failed tick must not kill the loop
        logger.exception("operation monitor tick failed")
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return 0
    finally:
        db.close()


def _loop(interval_seconds: float, stop_event: threading.Event) -> None:
    while not stop_event.is_set():
        run_once()
        stop_event.wait(interval_seconds)


def start_operation_monitor(*, enabled: bool, interval_seconds: float) -> threading.Event | None:
    if not enabled:
        return None
    stop_event = threading.Event()
    thread = threading.Thread(
        target=_loop,
        kwargs={"interval_seconds": interval_seconds, "stop_event": stop_event},
        name="operation-monitor",
        daemon=True,
    )
    thread.start()
    logger.info("operation monitor started (interval=%ss)", interval_seconds)
    return stop_event
