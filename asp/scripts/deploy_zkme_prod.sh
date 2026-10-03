#!/usr/bin/env bash
# Run ON the production host (SSH) inside the siphon-asp-v2 checkout.
# Usage:
#   cd /path/to/siphon-asp-v2
#   cp /secure/zkme.env .env.production   # never commit; chmod 600
#   bash scripts/deploy_zkme_prod.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env.production ]]; then
  echo "Missing .env.production — copy from .env.production.example and fill secrets." >&2
  exit 1
fi

required=(ZKME_MCH_NO ZKME_API_KEY ASP_COMPLIANCE_VAULT ASP_SCREEN_TOKEN ASP_POSTMAN_TOKEN ASP_ADMIN_TOKEN)
for v in "${required[@]}"; do
  if ! grep -q "^${v}=." .env.production 2>/dev/null; then
    echo "ERROR: set ${v} in .env.production before deploying zkMe." >&2
    exit 1
  fi
done

echo "==> git pull"
git pull --ff-only origin main

echo "==> rebuild asp (postman/watcher unchanged unless image stale)"
docker compose --env-file .env.production up -d --build asp

echo "==> wait for health"
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:5056/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "==> /ready (must be ready:true)"
curl -s http://127.0.0.1:5056/ready | python3 -m json.tool

echo "==> zkMe smoke (loads .env.production via zkme_smoke)"
set -a
# shellcheck disable=SC1091
source .env.production
set +a
python3 scripts/zkme_smoke.py

echo "==> public URL"
curl -s https://api.siphon.money/aspv2/ready | python3 -m json.tool

echo "Done. Update Amplify ASP_URL=https://api.siphon.money/aspv2 and ASP_SCREEN_TOKEN to match .env.production."
