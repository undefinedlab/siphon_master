#!/usr/bin/env bash
# Regenerate zkeys for circuits whose r1cs postdates zkey (payee-bind rebuild).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ART="$ROOT/artifacts"
PTAU="$ART/powersOfTau28_hez_final_20.ptau"
SNARKJS="$ROOT/node_modules/.bin/snarkjs"
DEV_BEACON="0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
MAIN="$ROOT/circuits/main"
NODE_MOD="$ROOT/node_modules"

build_one() {
  local key="$1"
  local out="$ART/$key"
  mkdir -p "$out"
  echo "==> [$key] compile"
  circom "$MAIN/${key}.circom" --r1cs --wasm --sym -o "$out" -l "$NODE_MOD"
  cp "$out/${key}_js/${key}.wasm" "$out/${key}.wasm"
  echo "==> [$key] groth16 setup"
  "$SNARKJS" groth16 setup "$out/${key}.r1cs" "$PTAU" "$out/zkey_0.zkey"
  "$SNARKJS" zkey beacon "$out/zkey_0.zkey" "$out/zkey_final.zkey" "$DEV_BEACON" 10
  "$SNARKJS" zkey export verificationkey "$out/zkey_final.zkey" "$out/verification_key.json"
  rm -f "$out/zkey_0.zkey" "$out/${key}.r1cs" "$out/${key}.sym"
  rm -rf "$out/${key}_js"
  echo "==> [$key] OK"
}

for key in ragequit withdraw1; do
  build_one "$key"
done

echo "==> All done"
