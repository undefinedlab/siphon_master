"""Standalone scheduler process — run separately from gunicorn API workers.

Usage:
  python scheduler_main.py

Requires the same env as the trade-executor. Only ONE scheduler should run
cluster-wide (use Redis lock when REDIS_URL is set).
"""
from __future__ import annotations

import os
import sys
import time

# Ensure trade-executor dir is on path when launched as a script
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _acquire_leader_lock():
    """Optional Redis leader lock so accidental dual schedulers cannot start."""
    url = (os.getenv("REDIS_URL") or "").strip()
    if not url:
        return None
    try:
        import redis

        r = redis.from_url(url, decode_responses=True)
        # SET NX with refresh in the loop
        ok = r.set("siphon:scheduler:leader", str(os.getpid()), nx=True, ex=60)
        if not ok:
            print("[scheduler_main] another leader holds siphon:scheduler:leader — exiting")
            sys.exit(0)
        return r
    except Exception as e:
        print(f"[scheduler_main] Redis leader lock unavailable: {e}")
        return None


def main():
    # Import app after path setup; do NOT start scheduler via gunicorn post_fork.
    from app import app, start_scheduler

    r = _acquire_leader_lock()
    print("[scheduler_main] starting scheduler (API workers should set RUN_SCHEDULER_IN_WORKER=0)")
    with app.app_context():
        start_scheduler()
        # Keep process alive; refresh leader lock
        while True:
            if r is not None:
                try:
                    r.set("siphon:scheduler:leader", str(os.getpid()), xx=True, ex=60)
                except Exception:
                    pass
            time.sleep(20)


if __name__ == "__main__":
    main()
