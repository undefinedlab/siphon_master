"""The billing thread is only closed if something actually *runs* `metering.reconcile()`.

Task 21 built `reconcile()` but nothing invoked it, so a live gateway never pulled the executor's
`execution` outbox → executions were never recorded (spec §5.1 requires recording in v1). These
tests pin the trigger: one tick calls `reconcile` exactly once with a fresh DB session + the executor
client, and the loop is a no-op when disabled.
"""
import threading
from unittest.mock import MagicMock

from app.services import reconcile_worker


def test_run_once_calls_reconcile_with_session_and_executor(monkeypatch):
    calls = []

    fake_session = MagicMock(name="session")
    monkeypatch.setattr(reconcile_worker, "SessionLocal", lambda: fake_session)

    fake_executor = MagicMock(name="executor")
    monkeypatch.setattr(reconcile_worker, "get_executor_client", lambda: fake_executor)

    def fake_reconcile(db, executor):
        calls.append((db, executor))
        return 3

    monkeypatch.setattr(reconcile_worker.metering, "reconcile", fake_reconcile)

    n = reconcile_worker.run_once()

    assert n == 3
    assert calls == [(fake_session, fake_executor)]
    # the per-tick session is always closed, even on the happy path
    fake_session.close.assert_called_once()


def test_run_once_closes_session_and_swallows_errors(monkeypatch):
    fake_session = MagicMock(name="session")
    monkeypatch.setattr(reconcile_worker, "SessionLocal", lambda: fake_session)
    monkeypatch.setattr(reconcile_worker, "get_executor_client", lambda: MagicMock())

    def boom(db, executor):
        raise RuntimeError("executor down")

    monkeypatch.setattr(reconcile_worker.metering, "reconcile", boom)

    # A failed tick must not crash the loop and must still release the session.
    n = reconcile_worker.run_once()

    assert n == 0
    fake_session.close.assert_called_once()


def test_loop_ticks_then_stops(monkeypatch):
    ticks = []
    monkeypatch.setattr(reconcile_worker, "run_once", lambda: ticks.append(1))

    stop = threading.Event()

    # Stop the loop after the first tick so the test is deterministic.
    def fake_wait(timeout):
        stop.set()
        return True

    stop.wait = fake_wait  # type: ignore[method-assign]

    reconcile_worker._loop(interval_seconds=0.01, stop_event=stop)

    assert len(ticks) == 1


def test_start_reconcile_worker_disabled_is_noop(monkeypatch):
    started = []
    monkeypatch.setattr(reconcile_worker.threading, "Thread",
                        lambda *a, **k: started.append((a, k)) or MagicMock())

    handle = reconcile_worker.start_reconcile_worker(enabled=False, interval_seconds=30)

    assert handle is None
    assert started == []
