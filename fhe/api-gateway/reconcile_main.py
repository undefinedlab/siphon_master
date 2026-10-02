import time
import os
import signal
import sys

# Ensure app package is importable if run directly
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from app.config import get_settings
from app.services.reconcile_worker import start_reconcile_worker


def main():
    settings = get_settings()
    if not settings.base_mainnet_rpc:
        print("Missing RPC configuration. Exiting.")
        sys.exit(1)

    print("Starting Siphon Gateway Reconciler...")
    stop_event = start_reconcile_worker(
        enabled=True,
        interval_seconds=settings.reconcile_interval_seconds
    )
    if not stop_event:
        print("Reconciler is disabled in settings. Exiting.")
        sys.exit(0)

    # Handle graceful shutdown
    def shutdown(signum, frame):
        print("Shutdown signal received. Stopping reconciler...")
        stop_event.set()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Keep main thread alive
    while True:
        try:
            time.sleep(1)
        except KeyboardInterrupt:
            shutdown(None, None)


if __name__ == "__main__":
    main()
