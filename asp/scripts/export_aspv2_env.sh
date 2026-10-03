#!/usr/bin/env bash
# Export env lines for aspv2 + contracts-v2 bootstrap (both naming conventions).
# Usage: ./scripts/export_aspv2_env.sh [path/to/deployed_addresses.json]
#        eval "$(./scripts/export_aspv2_env.sh | grep -v '^#')"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="${1:-$ROOT/../siphon-contracts-v2/evm/deployments/chain-31337/deployed_addresses.json}"

if [[ ! -f "$DEPLOY" ]]; then
  echo "Deployment file not found: $DEPLOY" >&2
  exit 1
fi

CHAIN_ID="$(basename "$(dirname "$DEPLOY")" | sed 's/chain-//')"
HUB="$(python3 -c "import json; print(json.load(open('$DEPLOY'))['ComplianceHub'])")"
VAULT="$(python3 -c "import json; print(json.load(open('$DEPLOY'))['VaultKernel'])")"
POSTMAN="$(python3 -c "import json; d=json.load(open('$DEPLOY')); print(d.get('Postman') or d.get('postman') or '')")"

# Empty-tree roots from aspv2 / zkv2 fixtures (must match BootstrapVault PublishComplianceRoots).
ROOTS="$(
python3 - <<PY
import sys
from pathlib import Path
root = Path("$ROOT")
sys.path.insert(0, str(root))
from core.asp_tree import AspTree
from core.smt import build_empty_subtrees
print(AspTree().root())
print(build_empty_subtrees()[32])
PY
)"
ADMITTED_ROOT="$(echo "$ROOTS" | sed -n '1p')"
REVOKED_ROOT="$(echo "$ROOTS" | sed -n '2p')"

# RPC follows the chain the deployment actually came from. This used to be hardcoded to
# 127.0.0.1:8545, so exporting a Sepolia or Base deployment produced an aspv2 pointed at a local
# node that either was not running or was a completely different chain.
case "$CHAIN_ID" in
  31337)    DEFAULT_RPC="http://127.0.0.1:8545" ;;
  11155111) DEFAULT_RPC="https://ethereum-sepolia-rpc.publicnode.com" ;;
  8453)     DEFAULT_RPC="https://mainnet.base.org" ;;
  84532)    DEFAULT_RPC="https://sepolia.base.org" ;;
  *)        DEFAULT_RPC="" ;;
esac
RPC_URL="${ASP_RPC_URL:-$DEFAULT_RPC}"
if [[ -z "$RPC_URL" ]]; then
  echo "No default RPC for chain $CHAIN_ID — set ASP_RPC_URL before running this." >&2
  exit 1
fi

# The anvil dev key is only correct when the postman IS the anvil account. Emitting it for a real
# chain is worse than emitting nothing: it does not match POSTMAN_ADDRESS, so aspv2 starts happily
# and every root publish is rejected on-chain, which reads as a broken postman rather than a
# misconfigured key.
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
if [[ "$CHAIN_ID" == "31337" ]] && \
   [[ "$(printf %s "$POSTMAN" | tr A-Z a-z)" == "$(printf %s "$ANVIL_ADDR" | tr A-Z a-z)" ]]; then
  POSTMAN_KEY_LINE="ASP_POSTMAN_KEY=${ANVIL_KEY}   # anvil dev key — local only"
else
  POSTMAN_KEY_LINE="# ASP_POSTMAN_KEY must be the secret for ${POSTMAN} — set it yourself, never a dev key
ASP_POSTMAN_KEY="
fi

cat <<EOF
# Generated from $DEPLOY — source into shell: eval "\$(./scripts/export_aspv2_env.sh | grep -v '^#')"
ASP_RPC_URL=${RPC_URL}
ASP_RPC_URLS=${CHAIN_ID}:${RPC_URL}
# aspv2 names
ASP_COMPLIANCE_HUB_${CHAIN_ID}=${HUB}
ASP_COMPLIANCE_HUB=${HUB}
# contracts-v2 / forge PublishComplianceRoots names
COMPLIANCE_HUB_${CHAIN_ID}=${HUB}
COMPLIANCE_HUB_ADDRESS=${HUB}
VAULT_KERNEL_${CHAIN_ID}=${VAULT}
VAULT_KERNEL=${VAULT}
ASP_POSTMAN_ADDRESS=${POSTMAN}
${POSTMAN_KEY_LINE}
ASP_AUTO_PUBLISH_ROOT=0
ASP_ADMIT_EPOCH_SECONDS=300
ADMITTED_ROOT=${ADMITTED_ROOT}
REVOKED_ROOT=${REVOKED_ROOT}
EOF
