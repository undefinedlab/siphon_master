# Deploy scripts (v2)

Foundry broadcast scripts ported from `siphon-contracts/evm/scripts/` with v2 architecture.

## v1 → v2 mapping

| v1 (`siphon-contracts`) | v2 (`siphon-contracts-v2`) | Reusable? |
| --- | --- | --- |
| `deployEntrypoint.ts` | `script/DeployVaultStack.s.sol` | **Pattern** — different contracts |
| `deployVerifier.ts` | `script/DeployActionVerifiers.s.sol` | **Yes** — same 14 Groth16 VKs |
| `deploymentEnv.ts` | `scripts/deploymentEnv.js` | **Yes** — aliases retargeted to `VaultKernel` |
| `setAspPostman.ts` | *(none)* | **No** — postman is immutable on `ComplianceHub` |
| `initVaults.ts` | `script/BootstrapVault.s.sol` | **Pattern** — seed roots / register verifier |
| `ActionRouterDeploy` (tests) | `script/ActionRouterDeploy.sol` | **Yes** — shared library |

v2 has **no Entrypoint**, vault factories, or per-asset `initializeVaults`. One `VaultKernel` + real `Erc20AssetAdapter` / `Erc20SettlementAdapter` per deployment (or your audited adapters via env).

## Quick start (local Anvil)

```bash
cd evm
cp .env.example .env
# set GOVERNANCE_ADDRESS + POSTMAN_ADDRESS to anvil account [0]
npm run deploy:local
node scripts/printDeploymentEnv.js deployments/chain-31337/deployed_addresses.json
```

## Production broadcast

```bash
source .env   # GOVERNANCE_ADDRESS, POSTMAN_ADDRESS; optional ASSET_TOKEN, SETTLEMENT_DST_TOKEN
export REGISTRY_MIN_DELAY=86400
export PAUSE_DEPOSITS_ON_DEPLOY=true

forge script script/DeployVaultStack.s.sol:DeployVaultStack \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast \
  --verify
```

## Tempo Moderato (scaffolding only)

Product path is **Base vault + Tempo mainnet ramp** (LI.FI), then optional Stablecoin DEX / Zones — **not** a Siphon vault on Tempo.

`scripts/moderato.env.example` and `NETWORKS[42431]` remain for DEX/Zone prototypes. Do **not** treat `DeployVaultStack` on Moderato as the showcase path.

Governance follow-up (multisig):

```bash
# Timelock path
PROPOSE_VERIFIER=true SPEND_ROUTER_ADDRESS=0x... VERIFIER_REGISTRY_ADDRESS=0x... \
  forge script script/BootstrapVault.s.sol:BootstrapVault --rpc-url ... --broadcast

# After delay
REGISTER_VERIFIER=true ... forge script script/BootstrapVault.s.sol:BootstrapVault ...

# Migration seed (deposits must be paused, empty tree)
SEED_HISTORICAL_ROOT=<stateRoot> PAUSE_DEPOSITS=true \
  forge script script/BootstrapVault.s.sol:BootstrapVault ...
```

Postman publishes ASP/SMT roots:

```bash
COMPLIANCE_HUB_ADDRESS=0x... ADMITTED_ROOT=... REVOKED_ROOT=... \
  forge script script/BootstrapVault.s.sol:PublishComplianceRoots --rpc-url ... --broadcast
```

## Verifiers only (ceremony refresh)

```bash
forge script script/DeployActionVerifiers.s.sol:DeployActionVerifiers --rpc-url ... --broadcast
```

Then wire the new router via `BootstrapVault` / governance.

## Output

Addresses land in `deployments/chain-<id>/deployed_addresses.json` (same idea as v1 `ignition/deployments/`).
