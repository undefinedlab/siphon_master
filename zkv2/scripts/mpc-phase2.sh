#!/usr/bin/env bash
# ============================================================================
# Siphon PROTOCOL spend trusted-setup ceremony — COORDINATOR script
#
# Runs production phase-2 MPC for PROTOCOL Circom circuits
# (withdraw, merge, swap, split, ragequit — all nPublic=25) on Hermez
# powersOfTau28_hez_final_20.ptau (phase 1, already trusted).
#
# Flow:
#   1. ./scripts/mpc_phase2.sh init
#        Compiles circuits, runs groth16 setup, produces ceremony/round_0000/
#        -> send round_0000 + scripts/mpc_contribute.sh to contributor 1.
#   2. Each contributor runs mpc_contribute.sh -> returns round_0001, 0002, …
#        After receiving each round: verify its SHA256SUMS against the hashes
#        the contributor sent over a second channel, then forward to the next
#        contributor.
#   3. PRE-ANNOUNCE the beacon publicly BEFORE it exists, e.g.
#        "hash of Ethereum mainnet block 23500000".  When the block exists:
#      ./scripts/mpc_phase2.sh beacon <round-dir> <beacon-hex> "<source-desc>"
#   4. ./scripts/mpc_phase2.sh finalize [path/to/siphon-contracts-v2/evm]
#        Verifies every final zkey against r1cs+ptau, exports verification
#        keys and Solidity verifiers, builds transcript.tar.gz and
#        protocol-spend-manifest.json (preflight shape).
#   5. Reviewer (non-participant): ./scripts/mpc_phase2.sh verify
#        Re-checks the whole chain independently, then flips
#        ceremony.status to "reviewed" in the manifest and approves its
#        SHA-256 out-of-band.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CIRCUITS_DIR="$ROOT/circuits/main"
CEREMONY="$ROOT/ceremony"
NODE_MOD="$ROOT/node_modules"
PTAU="${PTAU:-$CEREMONY/powersOfTau28_hez_final_20.ptau}"
SNARKJS="$NODE_MOD/.bin/snarkjs"; [[ -x "$SNARKJS" ]] || SNARKJS="$(command -v snarkjs)"
export NODE_OPTIONS="--max-old-space-size=8192"

# macOS default bash is 3.2 (no associative arrays) — use functions instead.
CIRCUITS=(withdraw1 withdraw2 withdraw3 withdraw4 withdraw5 withdraw6 merge2 merge3 merge4 merge5 merge6 swap split ragequit)
main_of() { echo "$1"; }
expect_npublic() {
  case "$1" in
    withdraw1|withdraw2|withdraw3|withdraw4|withdraw5|withdraw6|merge2|merge3|merge4|merge5|merge6|swap|split|ragequit) echo 25;;
  esac
}
err() { echo "ERROR: $*" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then SHA() { sha256sum "$@"; }
else SHA() { shasum -a 256 "$@"; }; fi
sha_of() { SHA "$1" | cut -d" " -f1; }

need_ptau() {
  if [[ ! -f "$PTAU" ]]; then
    echo "==> Downloading powersOfTau28_hez_final_20.ptau (Hermez phase 1)…"
    mkdir -p "$(dirname "$PTAU")"
    curl -L --fail -o "$PTAU" \
      "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_20.ptau"
  fi
}

cmd_init() {
  command -v circom >/dev/null 2>&1 || err "circom 2.x required for init"
  circom --version 2>&1 | grep -qE '2\.[0-9]' || err "need circom 2.x"
  need_ptau
  local R0="$CEREMONY/round_0000"
  [[ -e "$R0" ]] && err "$R0 already exists — refusing to overwrite an active ceremony"
  mkdir -p "$R0" "$CEREMONY/r1cs"
  for key in "${CIRCUITS[@]}"; do
    local main; main="$(main_of "$key")"
    echo "==> [$key] compile + groth16 setup"
    circom "$CIRCUITS_DIR/$main.circom" --r1cs -o "$CEREMONY/r1cs" -l "$NODE_MOD"
    "$SNARKJS" groth16 setup "$CEREMONY/r1cs/$main.r1cs" "$PTAU" "$R0/${key}_0000.zkey"
  done
  echo "0" > "$R0/ROUND"
  ( cd "$R0" && SHA ./*.zkey ROUND > SHA256SUMS )
  SHA "$PTAU" > "$CEREMONY/ptau.sha256"
  echo ""
  echo "==> round_0000 ready. Send to contributor 1:"
  echo "    - $R0 (the whole directory)"
  echo "    - scripts/mpc-contribute.sh"
  echo "    Keep $CEREMONY/r1cs/ — finalize and the reviewer need it."
}

cmd_beacon() {
  local IN_DIR="$1" BEACON_HEX="$2" SOURCE_DESC="$3"
  [[ -f "$IN_DIR/ROUND" ]] || err "$IN_DIR is not a round directory"
  [[ "$BEACON_HEX" =~ ^[0-9a-fA-F]{64}$ ]] || err "beacon must be 64 hex chars (no 0x)"
  local ROUND; ROUND="$(cat "$IN_DIR/ROUND")"
  [[ "$ROUND" -ge 2 ]] || err "refusing to beacon with fewer than 2 human contributions (round=$ROUND)"
  printf -v ROUND_PAD "%04d" "$ROUND"
  ( cd "$IN_DIR" && SHA -c SHA256SUMS ) || err "incoming round checksum mismatch"
  local FIN="$CEREMONY/final"
  mkdir -p "$FIN"
  for key in "${CIRCUITS[@]}"; do
    echo "==> [$key] applying public beacon"
    "$SNARKJS" zkey beacon "$IN_DIR/${key}_${ROUND_PAD}.zkey" "$FIN/${key}_final.zkey" \
      "$BEACON_HEX" 10 -n="beacon: $SOURCE_DESC"
  done
  {
    echo "beacon_hex: $BEACON_HEX"
    echo "source: $SOURCE_DESC"
    echo "iterations: 10"
    echo "applied_to_round: $ROUND_PAD"
    echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$FIN/beacon.txt"
  ( cd "$FIN" && SHA ./*.zkey beacon.txt > SHA256SUMS )
  echo "==> final zkeys in $FIN"
}

cmd_finalize() {
  local HARDHAT_DIR="${1:-}"
  need_ptau
  local FIN="$CEREMONY/final" OUT="$CEREMONY/release"
  [[ -d "$FIN" ]] || err "run beacon first"
  mkdir -p "$OUT/verifiers" "$OUT/zk" "$CEREMONY/verify-logs"
  for key in "${CIRCUITS[@]}"; do
    local main; main="$(main_of "$key")"
    echo "==> [$key] verify + export"
    "$SNARKJS" zkey verify "$CEREMONY/r1cs/$main.r1cs" "$PTAU" "$FIN/${key}_final.zkey" \
      | tee "$CEREMONY/verify-logs/${key}.log" | tail -1
    grep -q "ZKey Ok" "$CEREMONY/verify-logs/${key}.log" || err "$key zkey verification FAILED"
    mkdir -p "$OUT/zk/$key"
    cp "$FIN/${key}_final.zkey" "$OUT/zk/$key/zkey_final.zkey"
    "$SNARKJS" zkey export verificationkey "$FIN/${key}_final.zkey" "$OUT/zk/$key/verification_key.json"
    local np; np="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUT/zk/$key/verification_key.json','utf8')).nPublic)")"
    [[ "$np" == "$(expect_npublic "$key")" ]] || err "$key nPublic=$np expected $(expect_npublic "$key")"
  done

  # The canonical exporter names each contract, embeds the zkey provenance header, and
  # normalizes whitespace — the same format the repo's existing verifiers carry.
  echo "==> exporting Solidity verifiers (canonical exporter)"
  node "$ROOT/scripts/export-verifiers.cjs" --artifacts "$OUT/zk" --contracts "$OUT/verifiers"

  echo "==> building transcript.tar.gz"
  local T="$CEREMONY/transcript-staging"
  rm -rf "$T"; mkdir -p "$T/receipts" "$T/rounds"
  cp "$CEREMONY"/round_*/receipt_*.txt "$T/receipts/" 2>/dev/null || true
  for d in "$CEREMONY"/round_*/; do cp "$d/SHA256SUMS" "$T/rounds/$(basename "$d").SHA256SUMS"; done
  cp -r "$CEREMONY/verify-logs" "$T/"
  cp "$FIN/beacon.txt" "$FIN/SHA256SUMS" "$T/"
  cp "$CEREMONY/ptau.sha256" "$T/"
  tar -czf "$CEREMONY/transcript.tar.gz" -C "$T" .
  tar -czf "$CEREMONY/proof-bundle.tar.gz" -C "$OUT" zk verifiers

  local TSHA BSHA; TSHA="$(sha_of "$CEREMONY/transcript.tar.gz")"; BSHA="$(sha_of "$CEREMONY/proof-bundle.tar.gz")"
  echo "==> writing protocol-spend-manifest.json"
  node - "$OUT" "$TSHA" "$BSHA" "$HARDHAT_DIR" <<'EOF'
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [out, tsha, bsha, hardhat] = process.argv.slice(2);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const names = [
  "SpendWithdrawVerifier1",
  "SpendWithdrawVerifier2",
  "SpendWithdrawVerifier3",
  "SpendWithdrawVerifier4",
  "SpendWithdrawVerifier5",
  "SpendWithdrawVerifier6",
  "SpendMergeVerifier2",
  "SpendMergeVerifier3",
  "SpendMergeVerifier4",
  "SpendMergeVerifier5",
  "SpendMergeVerifier6",
  "SpendSwapVerifier",
  "SpendSplitVerifier",
  "SpendRagequitVerifier",
];
const verifiers = {};
for (const name of names) {
  const src = fs.readFileSync(path.join(out, "verifiers", `${name}.sol`), "utf8");
  let bytecode = "FILL_AFTER_HARDHAT_COMPILE";
  if (hardhat) {
    const art = path.join(hardhat, "artifacts", "src", "verifiers", `${name}.sol`, `${name}.json`);
    if (fs.existsSync(art)) bytecode = sha(JSON.parse(fs.readFileSync(art, "utf8")).bytecode);
  }
  verifiers[name] = { sourceSha256: sha(src), bytecodeSha256: bytecode };
}
const manifest = {
  ceremony: { kind: "mpc", status: "pending-review", transcriptSha256: tsha, proofBundleSha256: bsha },
  circuits: ["withdraw1","withdraw2","withdraw3","withdraw4","withdraw5","withdraw6","merge2","merge3","merge4","merge5","merge6","swap","split","ragequit"],
  nPublic: 25,
  verifiers,
};
fs.writeFileSync(path.join(out, "..", "protocol-spend-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("manifest written; status is pending-review until the non-participant reviewer flips it");
EOF

  echo ""
  echo "============================================================"
  echo " transcriptSha256:  $TSHA"
  echo " proofBundleSha256: $BSHA"
  echo " release artifacts: $OUT (zk/ per-circuit + verifiers/)"
  echo " manifest:          $CEREMONY/protocol-spend-manifest.json"
  echo ""
  echo " Next: copy release/verifiers/*.sol into siphon-contracts-v2/evm/src/verifiers/,"
  echo " hardhat compile, re-run finalize with the evm dir to fill bytecode hashes,"
  echo " then hand transcript + bundle + manifest to the non-participant reviewer."
  echo "============================================================"
}

cmd_verify() {
  need_ptau
  local FIN="$CEREMONY/final"
  for key in "${CIRCUITS[@]}"; do
    echo "==> [$key] independent verification (prints every contribution + beacon)"
    "$SNARKJS" zkey verify "$CEREMONY/r1cs/$(main_of "$key").r1cs" "$PTAU" "$FIN/${key}_final.zkey" \
      | tee "$CEREMONY/verify-logs/${key}-review.log" \
      | grep -iE "contribution|beacon|ZKey Ok" || err "$key FAILED verification"
    echo "    (full log: ceremony/verify-logs/${key}-review.log — includes contribution hash blocks)"
  done
  echo ""
  echo "All 14 verified. Reviewer checklist:"
  echo " 1. Contribution names/hashes match the receipts in transcript.tar.gz."
  echo " 2. Beacon value matches the PRE-ANNOUNCED public source (check the block hash yourself)."
  echo " 3. Flip ceremony.status to \"reviewed\" in protocol-spend-manifest.json."
  echo " 4. Approve the manifest SHA-256 out-of-band (not via this repo/server)."
}

case "${1:-}" in
  init)     cmd_init ;;
  beacon)   shift; [[ $# -eq 3 ]] || err "usage: mpc_phase2.sh beacon <round-dir> <beacon-hex> \"<source>\""; cmd_beacon "$@" ;;
  finalize) shift; cmd_finalize "${1:-}" ;;
  verify)   cmd_verify ;;
  *) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
