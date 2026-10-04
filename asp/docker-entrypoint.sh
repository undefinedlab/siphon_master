#!/bin/sh
set -e
ROLE="${ASP_ROLE:-api}"
CHAIN_ID="${ASP_CHAIN_ID:-}"

case "$ROLE" in
  api)
    BIND_PORT="${PORT:-5056}"
    exec gunicorn -w 4 -b "0.0.0.0:${BIND_PORT}" --timeout 60 \
      --access-logfile - --error-logfile - app:app
    ;;
  postman)
    if [ -z "$CHAIN_ID" ]; then
      echo "ASP_CHAIN_ID required for postman role" >&2
      exit 1
    fi
    exec python postman.py loop --chain-id "$CHAIN_ID"
    ;;
  watcher)
    if [ -z "$CHAIN_ID" ]; then
      echo "ASP_CHAIN_ID required for watcher role" >&2
      exit 1
    fi
    exec python scripts/watch_deposits.py --chain-id "$CHAIN_ID" --loop
    ;;
  postman-sol)
    exec python postman_solana.py loop
    ;;
  watcher-sol)
    exec python scripts/watch_deposits_solana.py --loop
    ;;
  *)
    echo "Unknown ASP_ROLE=$ROLE" >&2
    exit 1
    ;;
esac
