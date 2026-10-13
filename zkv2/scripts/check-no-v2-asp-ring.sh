#!/usr/bin/env bash
# Fail CI if v2 ASP root-ring language reappears in spend surfaces (GF-M4).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Executable spend surfaces only (docs may name the forbidden pattern).
if command -v rg >/dev/null 2>&1; then
  FIND=(rg -n -e 'aspRoots\[' -e 'aspRootIsRecent' "$ROOT/circuits" "$ROOT/spend-core")
else
  FIND=(grep -RIn -e 'aspRoots\[' -e 'aspRootIsRecent' "$ROOT/circuits" "$ROOT/spend-core")
fi
if "${FIND[@]}" 2>/dev/null; then
  echo "FAIL: forbidden v2 ASP-ring patterns in circuits/spend-core"
  exit 1
fi
echo "OK: no v2 aspRoots ring in circuits/spend-core"
