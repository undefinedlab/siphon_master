#!/usr/bin/env bash
# ============================================================================
# Siphon PROTOCOL spend trusted-setup ceremony — CONTRIBUTOR script
#
# You received a directory (or tarball) containing 14 .zkey files and this
# script. Running it adds YOUR randomness to every circuit and produces the
# next round directory to send back to the coordinator.
#
# The security of the whole system rests on one property: at least one
# contributor generated real randomness and then destroyed it. This script
# mixes what you type with your operating system's secure randomness, uses
# it, and never writes it to disk.
#
# Requirements: macOS or Linux, Node.js 18+, ~8 GB free RAM, ~10 GB free disk.
# Time: roughly 30-90 minutes of mostly-unattended compute.
#
# Usage:
#   ./scripts/mpc-contribute.sh <name> <incoming-round-dir>
#   e.g. ./mpc_contribute.sh zen round_0001
# ============================================================================
set -euo pipefail

SNARKJS_PKG="snarkjs@0.7.5"
CIRCUITS=(withdraw1 withdraw2 withdraw3 withdraw4 withdraw5 withdraw6 merge2 merge3 merge4 merge5 merge6 swap split ragequit)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZK_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SNARKJS_BIN="$ZK_ROOT/node_modules/.bin/snarkjs"
SNARKJS_SHA256="$ZK_ROOT/node_modules/snarkjs/package.json"

err() { echo "ERROR: $*" >&2; exit 1; }

[[ $# -eq 2 ]] || { grep -E "^#( |=)" "$0" | sed "s/^# \{0,1\}//"; exit 1; }
NAME="$1"
IN_DIR="$(cd "$2" && pwd)"

# --- prerequisites ----------------------------------------------------------
if command -v sha256sum >/dev/null 2>&1; then SHA() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1;  then SHA() { shasum -a 256 "$@"; }
else err "need sha256sum or shasum"; fi
command -v node >/dev/null 2>&1 || err "Node.js not found. Install Node 18+ from https://nodejs.org"
[[ -x "$SNARKJS_BIN" ]] || err "snarkjs not found at $SNARKJS_BIN — run npm ci in siphon-zk"
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" -ge 18 ]] || err "Node 18+ required (found $(node -v))"

# --- verify the incoming round ---------------------------------------------
[[ -f "$IN_DIR/ROUND" ]] || err "$IN_DIR/ROUND missing — is this a ceremony round directory?"
ROUND="$(cat "$IN_DIR/ROUND")"
NEXT=$(( ROUND + 1 ))
printf -v ROUND_PAD  "%04d" "$ROUND"
printf -v NEXT_PAD   "%04d" "$NEXT"

echo "==> Verifying checksums of incoming round $ROUND_PAD"
( cd "$IN_DIR" && SHA -c SHA256SUMS ) || err "Checksum mismatch — STOP and tell the coordinator. Do not contribute."

for key in "${CIRCUITS[@]}"; do
  [[ -f "$IN_DIR/${key}_${ROUND_PAD}.zkey" ]] || err "missing ${key}_${ROUND_PAD}.zkey"
done

OUT_DIR="$(dirname "$IN_DIR")/round_${NEXT_PAD}"
[[ -e "$OUT_DIR" ]] && err "$OUT_DIR already exists — refusing to overwrite"
RECEIPT="$OUT_DIR/receipt_round${NEXT_PAD}_${NAME}.txt"

# --- collect entropy (never stored) -----------------------------------------
echo ""
echo "You will now type random entropy. Mash the keyboard for a while —"
echo "letters, numbers, whatever. It is combined with your OS's secure random"
echo "source, is NEVER displayed, and is NEVER written to disk."
echo ""
read -r -s -p "Type random characters, then press Enter: " USER_ENTROPY
echo ""
[[ -n "$USER_ENTROPY" ]] || err "empty entropy — type something random, then press Enter"

# Only NOW create the output dir. Creating it before the prompt meant any abort here (an empty
# Enter, a Ctrl-C) left an empty round_NNNN behind, and the existence check above then refused
# every retry — a dead end that looks like corruption.
mkdir -p "$OUT_DIR"

# --- contribute to all 14 circuits ------------------------------------------
export NODE_OPTIONS="--max-old-space-size=8192"
{
  echo "Siphon PROTOCOL spend phase-2 ceremony — contribution receipt"
  echo "contributor: $NAME"
  echo "round: $NEXT_PAD"
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host-os: $(uname -s) $(uname -m)"
  if [[ -f "$SNARKJS_SHA256" ]]; then
    echo "snarkjs: $(node -e "const p=require('$SNARKJS_SHA256');process.stdout.write(p.version||'?')")"
    echo "snarkjs-package-sha256: $(SHA "$SNARKJS_SHA256" | cut -d' ' -f1)"
  fi
  echo ""
} > "$RECEIPT"

START_TS=$(date +%s)
for key in "${CIRCUITS[@]}"; do
  IN_ZKEY="$IN_DIR/${key}_${ROUND_PAD}.zkey"
  OUT_ZKEY="$OUT_DIR/${key}_${NEXT_PAD}.zkey"
  # Fresh OS randomness per circuit, mixed with the typed entropy. The typed
  # part lives only in this process's memory.
  PER_CIRCUIT_RAND="$(node -e 'console.log(require("crypto").randomBytes(64).toString("hex"))')"
  ENTROPY="${USER_ENTROPY}${PER_CIRCUIT_RAND}"
  echo ""
  echo "==> [$key] contributing (this can take a few minutes for the big ones)…"
  echo "---- circuit: $key ----" >> "$RECEIPT"
  # Entropy via stdin — never on argv (/proc/PID/cmdline). No -e flag.
  printf '%s\n' "$ENTROPY" | "$SNARKJS_BIN" zkey contribute "$IN_ZKEY" "$OUT_ZKEY" \
    --name="$NAME (round $NEXT_PAD)" 2>&1 | tee -a "$RECEIPT" | grep -iE "contribution|hash" | head -6
  unset PER_CIRCUIT_RAND ENTROPY
done
unset USER_ENTROPY NODE_OPTIONS
ELAPSED=$(( $(date +%s) - START_TS ))

# --- seal the outgoing round -------------------------------------------------
echo "$NEXT" > "$OUT_DIR/ROUND"
( cd "$OUT_DIR" && SHA ./*.zkey ROUND > SHA256SUMS )

echo ""
echo "============================================================"
echo " DONE in ${ELAPSED}s. Your randomness is now baked into all 14 circuits."
echo ""
echo " Send the ENTIRE directory back to the coordinator:"
echo "   $OUT_DIR"
echo ""
echo " Then, over a DIFFERENT channel (e.g. Signal/SMS if you sent files via"
echo " Drive), send the contents of:"
echo "   $OUT_DIR/SHA256SUMS"
echo ""
echo " Keep your receipt for the public transcript:"
echo "   $RECEIPT"
echo ""
echo " Finally: close this terminal. Your typed entropy existed only in this"
echo " process's memory and is now gone — that act is what protects the funds."
echo "============================================================"
