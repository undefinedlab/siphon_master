#!/usr/bin/env bash
# Sync siphon-zkv2 test-vectors + manifest into fixtures/ for self-contained CI.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${SIPHON_ZKV2:-$ROOT/../siphon-zk-v2}"
DST="$ROOT/fixtures/zkv2"
[[ -d "$SRC/test-vectors" ]] || { echo "missing $SRC/test-vectors"; exit 1; }
mkdir -p "$DST/manifest"
rsync -a --delete "$SRC/test-vectors/" "$DST/test-vectors/"
cp "$SRC/manifest/universal-spend-v1.json" "$DST/manifest/"
echo "Synced fixtures from $SRC → $DST ($(find "$DST" -type f | wc -l) files)"
