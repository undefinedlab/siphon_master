"""Single-owner gateway background process: billing, chain state, then webhook delivery."""
import os
import signal
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from app.config import get_settings
from app.services.operation_monitor import start_operation_monitor
from app.services.reconcile_worker import start_reconcile_worker
from app.services.webhook_worker import start_webhook_worker


def main() -> None:
    settings = get_settings()
    stops = [
        start_reconcile_worker(
            enabled=settings.reconcile_enabled,
            interval_seconds=settings.reconcile_interval_seconds,
        ),
        start_operation_monitor(
            enabled=settings.operation_monitor_enabled,
            interval_seconds=settings.operation_monitor_interval_seconds,
        ),
        start_webhook_worker(
            enabled=settings.webhook_enabled,
            interval_seconds=settings.webhook_worker_interval_seconds,
        ),
    ]
    stops = [stop for stop in stops if stop is not None]
    if not stops:
        print("All gateway background services are disabled. Exiting.")
        return

    def shutdown(_signum, _frame):
        for stop in stops:
            stop.set()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    print("Siphon gateway background worker started.")
    while not any(stop.is_set() for stop in stops):
        time.sleep(1)


if __name__ == "__main__":
    main()
