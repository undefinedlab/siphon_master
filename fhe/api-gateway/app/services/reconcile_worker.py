"""Background reconciler — the trigger that actually runs `metering.reconcile()`.

The executor emits `execution` events into an outbox (`/execution-events`); nothing bills for them
until the gateway pulls them in. `metering.reconcile()` does the pull+attribute, but it needs a
caller. This module is that caller: a daemon thread started at app boot that ticks every
`reconcile_interval_seconds`, each tick using a fresh short-lived DB session and the shared executor
client.

Sync (threading + sync Session/httpx) to match `metering.reconcile`'s sync signature and mirror the
executor's own `worker_loop` threading pattern. A tick that fails is logged and swallowed so one bad
poll never kills the loop; the session is always closed. Recording only — no auto-debit (v1, §5.2).
"""
import logging
import threading

from app.deps.clients import get_executor_client
from app.repository.session import SessionLocal
from app.services import metering

logger = logging.getLogger("siphon.gateway.reconcile")


def run_once() -> int:
    """One reconcile tick: pull the executor outbox and record new `execution` usage.

    Returns the count reconciled (0 on any failure). Never raises — a background loop must survive a
    transient executor/DB outage. The per-tick session is always closed.
    """
    db = SessionLocal()
    try:
        executor = get_executor_client()
        n = metering.reconcile(db, executor)
        db.commit()
        if n:
            logger.info("reconcile tick recorded %d execution event(s)", n)
        return n
    except Exception:  # noqa: BLE001 — a failed tick must not kill the loop
        logger.exception("reconcile tick failed")
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return 0
    finally:
        db.close()


def _loop(interval_seconds: float, stop_event: threading.Event) -> None:
    """Tick `run_once` every `interval_seconds` until `stop_event` is set."""
    while not stop_event.is_set():
        run_once()
        # wait() returns True when the event is set — lets shutdown interrupt the sleep promptly.
        stop_event.wait(interval_seconds)


def start_reconcile_worker(*, enabled: bool, interval_seconds: float) -> threading.Event | None:
    """Start the reconcile loop as a daemon thread. No-op (returns None) when disabled — e.g. in
    tests, or on a worker that shouldn't own reconciliation. Returns the stop Event so a caller can
    signal shutdown."""
    if not enabled:
        return None
    stop_event = threading.Event()
    thread = threading.Thread(
        target=_loop,
        kwargs={"interval_seconds": interval_seconds, "stop_event": stop_event},
        name="reconcile-worker",
        daemon=True,
    )
    thread.start()
    logger.info("reconcile worker started (interval=%ss)", interval_seconds)
    return stop_event
