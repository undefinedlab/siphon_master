#!/bin/sh
set -eu
echo "[api-gateway] running alembic upgrade head..."
alembic upgrade head
echo "[api-gateway] migrations ok; starting: $*"
exec "$@"
