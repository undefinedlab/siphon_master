#!/usr/bin/env bash
# Dev-beacon Groth16 build for PROTOCOL spend circuits (25-limb publics).
# NOT for mainnet — run scripts/mpc-phase2.sh for production keys.
#
# Usage:
#   ./scripts/build.sh
#   COPY_TO_APP=1 ./scripts/build.sh   # sync to siphon-app/public/zk (blocked if CEREMONY.json reviewed)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN="$ROOT/circuits/main"
ART="$ROOT/artifacts"
NODE_MOD="$ROOT/node_modules"
PTAU_NAME="powersOfTau28_hez_final_20.ptau"
PTAU="${PTAU:-$ART/$PTAU_NAME}"
APP_ZK="$(cd "$ROOT/.." && pwd)/siphon-app/public/zk"

export PATH="${HOME}/.local/bin:${PATH}"

need() { command -v "$1" >/dev/null || { echo "ERROR: need $1"; exit 1; }; }
need circom
need node
circom --version 2>&1 | grep -qE '2\.[0-9]' || { echo "ERROR: circom 2.x required"; exit 1; }

SNARKJS="$NODE_MOD/.bin/snarkjs"
[[ -x "$SNARKJS" ]] || SNARKJS="$(command -v snarkjs)"

# shellcheck source=scripts/lib/circuits.cjs
CIRCUIT_KEYS="$(node -e "const {CIRCUITS}=require('$ROOT/scripts/lib/circuits.cjs'); console.log(CIRCUITS.map(c=>c.key+':'+c.main+':'+c.nPublic).join('\n'))")"

mkdir -p "$ART"
if [[ ! -f "$PTAU" ]]; then
  echo "==> Downloading $PTAU_NAME"
  curl -L --fail -o "$PTAU" \
    "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_20.ptau"
fi

DEV_BEACON="0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

build_one() {
  local key="$1" main="$2" expect="$3"
  local out="$ART/$key"
  mkdir -p "$out"

  echo ""
  echo "==> [$key] compile $main.circom"
  circom "$MAIN/$main.circom" --r1cs --wasm --sym -o "$out" -l "$NODE_MOD"

  local r1cs="$out/$main.r1cs"
  local wasm="$out/${main}_js/$main.wasm"
  cp "$wasm" "$out/$main.wasm"

  echo "    groth16 setup + dev beacon"
  "$SNARKJS" groth16 setup "$r1cs" "$PTAU" "$out/zkey_0.zkey"
  "$SNARKJS" zkey beacon "$out/zkey_0.zkey" "$out/zkey_final.zkey" "$DEV_BEACON" 10
  "$SNARKJS" zkey export verificationkey "$out/zkey_final.zkey" "$out/verification_key.json"

  rm -f "$out/zkey_0.zkey" "$r1cs" "$out/$main.sym"
  rm -rf "$out/${main}_js"

  local np
  np="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$out/verification_key.json','utf8')).nPublic)")"
  [[ "$np" == "$expect" ]] || { echo "ERROR: $key nPublic=$np expected $expect"; exit 1; }
  echo "    OK nPublic=$np"
}

while IFS=: read -r key main expect; do
  [[ -n "$key" ]] && build_one "$key" "$main" "$expect"
done <<< "$CIRCUIT_KEYS"

echo ""
echo "==> Built under $ART"

if [[ "${COPY_TO_APP:-0}" == "1" ]]; then
  CEREMONY_JSON="$APP_ZK/CEREMONY.json"
  if [[ -f "$CEREMONY_JSON" ]]; then
    STATUS="$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('$CEREMONY_JSON','utf8')).status||'')}catch{process.stdout.write('')}")"
    if [[ "$STATUS" == "reviewed" ]]; then
      echo "ERROR: refusing COPY_TO_APP — $CEREMONY_JSON status=reviewed"
      exit 1
    fi
  fi
  echo "==> Syncing to $APP_ZK"
  while IFS=: read -r key main _; do
    [[ -z "$key" ]] && continue
    mkdir -p "$APP_ZK/$key"
    cp "$ART/$key/zkey_final.zkey" "$APP_ZK/$key/"
    cp "$ART/$key/verification_key.json" "$APP_ZK/$key/"
    cp "$ART/$key/$main.wasm" "$APP_ZK/$key/main_${key}.wasm"
  done <<< "$CIRCUIT_KEYS"
fi

echo ""
echo "WARNING: dev-beacon keys — run MPC before mainnet."
