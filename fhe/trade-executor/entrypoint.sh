#!/bin/bash
set -e

echo "=== Siphon Trade Executor Starting ==="

# Run database initialization if needed
echo "Initializing database..."
python init_db.py || echo "Database already initialized or init_db.py not found"

# SQLite requires single worker to avoid locking issues
# Also use --preload to ensure scheduler starts only once
WORKERS=${GUNICORN_WORKERS:-1}
# The FHE server key is ~100MB; uploading + JSON-parsing + storing it on the single SQLite
# worker exceeded the old 120s timeout, so gunicorn killed the worker mid-request → 502 on
# /uploadServerKey. Give it room (env-overridable).
GUNICORN_TIMEOUT=${GUNICORN_TIMEOUT:-600}
# One sync thread meant a single slow request (a ~28MB key upload over a slow uplink)
# wedged EVERY other endpoint — /health included — for up to GUNICORN_TIMEOUT seconds.
# gthread keeps the one-process SQLite constraint (the scheduler is already a thread)
# while letting requests run concurrently.
THREADS=${GUNICORN_THREADS:-8}
echo "Starting gunicorn with $WORKERS worker x $THREADS threads (SQLite mode), timeout ${GUNICORN_TIMEOUT}s..."

# Start gunicorn with production settings.
# The scheduler is started from gunicorn.conf.py's post_fork hook (exactly once,
# inside the single worker) — NOT at import time. Keep --preload for fast worker
# boot; the master's preload import no longer starts a scheduler.
# Railway injects PORT; default 5005 for local/compose.
BIND_PORT="${PORT:-5005}"
exec gunicorn \
    --bind "0.0.0.0:${BIND_PORT}" \
    --workers $WORKERS \
    --threads $THREADS \
    --timeout $GUNICORN_TIMEOUT \
    --keep-alive 5 \
    --access-logfile - \
    --error-logfile - \
    --capture-output \
    --preload \
    --config gunicorn.conf.py \
    app:app
