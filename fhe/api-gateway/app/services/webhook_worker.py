"""Background webhook delivery loop.

Mirrors `reconcile_worker`: a daemon thread, a fresh short-lived session per tick, every failure
logged and swallowed so one bad poll never kills the loop. Deliveries are persisted `pending` by
the request path, so this worker is a retry engine — nothing is lost if it is down for a while.

One shared httpx client per tick gets connection reuse across a burst of deliveries without holding
a pool open between ticks.
"""
import logging
import threading

import httpx

from app.config import get_settings
from app.repository.session import SessionLocal
from app.services import webhook_service

logger = logging.getLogger("siphon.gateway.webhook_worker")


def run_once(*, limit: int = 50) -> int:
    """One delivery tick. Returns the count delivered (0 on any failure). Never raises."""
    settings = get_settings()
    db = SessionLocal()
    try:
        with httpx.Client(timeout=settings.webhook_timeout_seconds) as client:
            n = webhook_service.drain_pending(db, limit=limit, client=client)
        db.commit()
        if n:
            logger.info("webhook tick delivered %d event(s)", n)
        return n
    except Exception:  # noqa: BLE001 — a failed tick must not kill the loop
        logger.exception("webhook delivery tick failed")
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


def start_webhook_worker(*, enabled: bool, interval_seconds: float) -> threading.Event | None:
    if not enabled:
        return None
    stop_event = threading.Event()
    thread = threading.Thread(
        target=_loop,
        kwargs={"interval_seconds": interval_seconds, "stop_event": stop_event},
        name="webhook-worker",
        daemon=True,
    )
    thread.start()
    logger.info("webhook worker started (interval=%ss)", interval_seconds)
    return stop_event
