/**
 * v3 (PROTOCOL 3.5 / PROGRAM_VERSION 4) deployment config.
 *
 * v3 is a different on-chain shape from the v2 Entrypoint/Vault stack: a single
 * `VaultKernel.spend(publicInputs[25], proof, actionCalldata)` kernel + a `ComplianceHub` holding
 * the current admittedRoot/revokedRoot. Addresses come from env (per chain) and are NOT yet
 * deployed — until they are, {@link v3Deployed} is false and the v3 spend paths refuse to submit.
 */

import { zkUrl } from "../zkAssets";

/**
 * 5, not 4: COMPLIANCE_CIRCUIT_SPLIT. The kernel reads this from spend limb 16 and looks the
 * verifier up as `VerifierRegistry.verifiers(version)`, so a stale 4 resolves to address(0) and
 * every spend reverts. Both circuit halves also assert `programVersion === 5` internally.
 */
export const PROGRAM_VERSION_V3 = 5;

export interface V3ChainConfig {
  chainId: number;
  /** Single spend kernel — deposit + spend(). */
  vaultKernel: string;
  /** Current admittedRoot / revokedRoot holder. */
  complianceHub: string;
  /** Uniswap V3 (or bootstrap) settlement adapter for swaps. */
  settlementAdapter: string;
  /** Indexer base serving /state/leaves and /vault-index/*. */
  indexerUrl: string;
  /** ASP service base (screen/paths/roots). */
  aspUrl: string;
  /** Executor/relayer base that submits spend() and relays. */
  executorUrl: string;
  /** Block the kernel was deployed at (leaf scan start). */
  deployBlock: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Next.js substitutes `process.env.NEXT_PUBLIC_X` only where it appears as a LITERAL member
 * expression — webpack rewrites it at build time. A computed `process.env[key]` is left alone,
 * and in the browser bundle `process.env` carries none of these, so every lookup below returned
 * undefined: addresses fell back to ZERO, `v3Deployed()` reported false, and the dashboard
 * silently routed deposits and balance reads down the retired v2 path against a dead indexer.
 * Reading through this literal map keeps the call sites key-driven while staying inlinable.
 */
const ENV: Record<string, string | undefined> = {
  NEXT_PUBLIC_VAULT_INDEX_URL: process.env.NEXT_PUBLIC_VAULT_INDEX_URL,

  NEXT_PUBLIC_V3_SEPOLIA_VAULT_KERNEL: process.env.NEXT_PUBLIC_V3_SEPOLIA_VAULT_KERNEL,
  NEXT_PUBLIC_V3_SEPOLIA_COMPLIANCE_HUB: process.env.NEXT_PUBLIC_V3_SEPOLIA_COMPLIANCE_HUB,
  NEXT_PUBLIC_V3_SEPOLIA_SETTLEMENT_ADAPTER: process.env.NEXT_PUBLIC_V3_SEPOLIA_SETTLEMENT_ADAPTER,
  NEXT_PUBLIC_V3_SEPOLIA_INDEXER_URL: process.env.NEXT_PUBLIC_V3_SEPOLIA_INDEXER_URL,
  NEXT_PUBLIC_V3_SEPOLIA_ASP_URL: process.env.NEXT_PUBLIC_V3_SEPOLIA_ASP_URL,
  NEXT_PUBLIC_V3_SEPOLIA_EXECUTOR_URL: process.env.NEXT_PUBLIC_V3_SEPOLIA_EXECUTOR_URL,
  NEXT_PUBLIC_V3_SEPOLIA_DEPLOY_BLOCK: process.env.NEXT_PUBLIC_V3_SEPOLIA_DEPLOY_BLOCK,

  NEXT_PUBLIC_V3_BASE_VAULT_KERNEL: process.env.NEXT_PUBLIC_V3_BASE_VAULT_KERNEL,
  NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB: process.env.NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB,
  NEXT_PUBLIC_V3_BASE_SETTLEMENT_ADAPTER: process.env.NEXT_PUBLIC_V3_BASE_SETTLEMENT_ADAPTER,
  NEXT_PUBLIC_V3_BASE_INDEXER_URL: process.env.NEXT_PUBLIC_V3_BASE_INDEXER_URL,
  NEXT_PUBLIC_V3_BASE_ASP_URL: process.env.NEXT_PUBLIC_V3_BASE_ASP_URL,
  NEXT_PUBLIC_V3_BASE_EXECUTOR_URL: process.env.NEXT_PUBLIC_V3_BASE_EXECUTOR_URL,
  NEXT_PUBLIC_V3_BASE_DEPLOY_BLOCK: process.env.NEXT_PUBLIC_V3_BASE_DEPLOY_BLOCK,

  NEXT_PUBLIC_V3_ARBITRUM_VAULT_KERNEL: process.env.NEXT_PUBLIC_V3_ARBITRUM_VAULT_KERNEL,
  NEXT_PUBLIC_V3_ARBITRUM_COMPLIANCE_HUB: process.env.NEXT_PUBLIC_V3_ARBITRUM_COMPLIANCE_HUB,
  NEXT_PUBLIC_V3_ARBITRUM_SETTLEMENT_ADAPTER: process.env.NEXT_PUBLIC_V3_ARBITRUM_SETTLEMENT_ADAPTER,
  NEXT_PUBLIC_V3_ARBITRUM_INDEXER_URL: process.env.NEXT_PUBLIC_V3_ARBITRUM_INDEXER_URL,
  NEXT_PUBLIC_V3_ARBITRUM_ASP_URL: process.env.NEXT_PUBLIC_V3_ARBITRUM_ASP_URL,
  NEXT_PUBLIC_V3_ARBITRUM_EXECUTOR_URL: process.env.NEXT_PUBLIC_V3_ARBITRUM_EXECUTOR_URL,
  NEXT_PUBLIC_V3_ARBITRUM_DEPLOY_BLOCK: process.env.NEXT_PUBLIC_V3_ARBITRUM_DEPLOY_BLOCK,

  NEXT_PUBLIC_V3_TEMPO_MODERATO_VAULT_KERNEL: process.env.NEXT_PUBLIC_V3_TEMPO_MODERATO_VAULT_KERNEL,
  NEXT_PUBLIC_V3_TEMPO_MODERATO_COMPLIANCE_HUB: process.env.NEXT_PUBLIC_V3_TEMPO_MODERATO_COMPLIANCE_HUB,
  NEXT_PUBLIC_V3_TEMPO_MODERATO_SETTLEMENT_ADAPTER: process.env.NEXT_PUBLIC_V3_TEMPO_MODERATO_SETTLEMENT_ADAPTER,
  NEXT_PUBLIC_V3_TEMPO_MODERATO_INDEXER_URL: process.env.NEXT_PUBLIC_V3_TEMPO_MODERATO_INDEXER_URL,
  NEXT_PUBLIC_V3_TEMPO_MODERATO_ASP_URL: process.env.NEXT_PUBLIC_V3_TEMPO_MODERATO_ASP_URL,
  NEXT_PUBLIC_V3_TEMPO_MODERATO_EXECUTOR_URL: process.env.NEXT_PUBLIC_V3_TEMPO_MODERATO_EXECUTOR_URL,
  NEXT_PUBLIC_V3_TEMPO_MODERATO_DEPLOY_BLOCK: process.env.NEXT_PUBLIC_V3_TEMPO_MODERATO_DEPLOY_BLOCK,

  NEXT_PUBLIC_V3_HYPEREVM_TESTNET_VAULT_KERNEL: process.env.NEXT_PUBLIC_V3_HYPEREVM_TESTNET_VAULT_KERNEL,
  NEXT_PUBLIC_V3_HYPEREVM_TESTNET_COMPLIANCE_HUB: process.env.NEXT_PUBLIC_V3_HYPEREVM_TESTNET_COMPLIANCE_HUB,
  NEXT_PUBLIC_V3_HYPEREVM_TESTNET_SETTLEMENT_ADAPTER: process.env.NEXT_PUBLIC_V3_HYPEREVM_TESTNET_SETTLEMENT_ADAPTER,
  NEXT_PUBLIC_V3_HYPEREVM_TESTNET_INDEXER_URL: process.env.NEXT_PUBLIC_V3_HYPEREVM_TESTNET_INDEXER_URL,
  NEXT_PUBLIC_V3_HYPEREVM_TESTNET_ASP_URL: process.env.NEXT_PUBLIC_V3_HYPEREVM_TESTNET_ASP_URL,
  NEXT_PUBLIC_V3_HYPEREVM_TESTNET_EXECUTOR_URL: process.env.NEXT_PUBLIC_V3_HYPEREVM_TESTNET_EXECUTOR_URL,
  NEXT_PUBLIC_V3_HYPEREVM_TESTNET_DEPLOY_BLOCK: process.env.NEXT_PUBLIC_V3_HYPEREVM_TESTNET_DEPLOY_BLOCK,
};

function envAddr(key: string): string {
  const v = (ENV[key] || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : ZERO;
}
function envUrl(key: string, fallback = ""): string {
  return (ENV[key] || fallback).replace(/\/+$/, "");
}
function envNum(key: string, fallback = 0): number {
  const n = Number(ENV[key]);
  return Number.isFinite(n) ? n : fallback;
}

/** Sepolia (11155111) — primary v3 testnet target. */
const SEPOLIA: V3ChainConfig = {
  chainId: 11155111,
  vaultKernel: envAddr("NEXT_PUBLIC_V3_SEPOLIA_VAULT_KERNEL"),
  complianceHub: envAddr("NEXT_PUBLIC_V3_SEPOLIA_COMPLIANCE_HUB"),
  settlementAdapter: envAddr("NEXT_PUBLIC_V3_SEPOLIA_SETTLEMENT_ADAPTER"),
  indexerUrl: envUrl("NEXT_PUBLIC_V3_SEPOLIA_INDEXER_URL", envUrl("NEXT_PUBLIC_VAULT_INDEX_URL")),
  aspUrl: envUrl("NEXT_PUBLIC_V3_SEPOLIA_ASP_URL"),
  executorUrl: envUrl("NEXT_PUBLIC_V3_SEPOLIA_EXECUTOR_URL"),
  deployBlock: envNum("NEXT_PUBLIC_V3_SEPOLIA_DEPLOY_BLOCK"),
};

/** Base mainnet (8453) — v3 target once deployed. */
const BASE: V3ChainConfig = {
  chainId: 8453,
  vaultKernel: envAddr("NEXT_PUBLIC_V3_BASE_VAULT_KERNEL"),
  complianceHub: envAddr("NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB"),
  settlementAdapter: envAddr("NEXT_PUBLIC_V3_BASE_SETTLEMENT_ADAPTER"),
  indexerUrl: envUrl("NEXT_PUBLIC_V3_BASE_INDEXER_URL", envUrl("NEXT_PUBLIC_VAULT_INDEX_URL")),
  aspUrl: envUrl("NEXT_PUBLIC_V3_BASE_ASP_URL"),
  executorUrl: envUrl("NEXT_PUBLIC_V3_BASE_EXECUTOR_URL"),
  deployBlock: envNum("NEXT_PUBLIC_V3_BASE_DEPLOY_BLOCK"),
};

/**
 * Arbitrum One (42161) — v5 stack, 2026-09-28. v3-ONLY: there is no v2 Entrypoint on this chain.
 * Its executor/ASP/indexer are a separate host (the mock-TEE box), not the Base executor.
 * deployBlock is the real L2 block: Arbitrum's Solidity `block.number` is an L1 estimate, so the
 * deploy script's logged block (26075472) is wrong for every log scan.
 */
const ARBITRUM: V3ChainConfig = {
  chainId: 42161,
  vaultKernel: envAddr("NEXT_PUBLIC_V3_ARBITRUM_VAULT_KERNEL"),
  complianceHub: envAddr("NEXT_PUBLIC_V3_ARBITRUM_COMPLIANCE_HUB"),
  settlementAdapter: envAddr("NEXT_PUBLIC_V3_ARBITRUM_SETTLEMENT_ADAPTER"),
  indexerUrl: envUrl("NEXT_PUBLIC_V3_ARBITRUM_INDEXER_URL"),
  aspUrl: envUrl("NEXT_PUBLIC_V3_ARBITRUM_ASP_URL"),
  executorUrl: envUrl("NEXT_PUBLIC_V3_ARBITRUM_EXECUTOR_URL"),
  deployBlock: envNum("NEXT_PUBLIC_V3_ARBITRUM_DEPLOY_BLOCK", 509682895),
};

/** Tempo Moderato (42431) — scaffolding only; no Siphon vault deploy (ramp+DEX+Zones product). */
const TEMPO_MODERATO: V3ChainConfig = {
  chainId: 42431,
  vaultKernel: envAddr("NEXT_PUBLIC_V3_TEMPO_MODERATO_VAULT_KERNEL"),
  complianceHub: envAddr("NEXT_PUBLIC_V3_TEMPO_MODERATO_COMPLIANCE_HUB"),
  settlementAdapter: envAddr("NEXT_PUBLIC_V3_TEMPO_MODERATO_SETTLEMENT_ADAPTER"),
  indexerUrl: envUrl("NEXT_PUBLIC_V3_TEMPO_MODERATO_INDEXER_URL", envUrl("NEXT_PUBLIC_VAULT_INDEX_URL")),
  aspUrl: envUrl("NEXT_PUBLIC_V3_TEMPO_MODERATO_ASP_URL"),
  executorUrl: envUrl("NEXT_PUBLIC_V3_TEMPO_MODERATO_EXECUTOR_URL"),
  deployBlock: envNum("NEXT_PUBLIC_V3_TEMPO_MODERATO_DEPLOY_BLOCK"),
};

/** HyperEVM Testnet (998) — admin native vault; addresses empty until DeployVaultStack broadcast. */
const HYPEREVM_TESTNET: V3ChainConfig = {
  chainId: 998,
  vaultKernel: envAddr("NEXT_PUBLIC_V3_HYPEREVM_TESTNET_VAULT_KERNEL"),
  complianceHub: envAddr("NEXT_PUBLIC_V3_HYPEREVM_TESTNET_COMPLIANCE_HUB"),
  settlementAdapter: envAddr("NEXT_PUBLIC_V3_HYPEREVM_TESTNET_SETTLEMENT_ADAPTER"),
  indexerUrl: envUrl("NEXT_PUBLIC_V3_HYPEREVM_TESTNET_INDEXER_URL", envUrl("NEXT_PUBLIC_VAULT_INDEX_URL")),
  aspUrl: envUrl("NEXT_PUBLIC_V3_HYPEREVM_TESTNET_ASP_URL"),
  executorUrl: envUrl("NEXT_PUBLIC_V3_HYPEREVM_TESTNET_EXECUTOR_URL"),
  deployBlock: envNum("NEXT_PUBLIC_V3_HYPEREVM_TESTNET_DEPLOY_BLOCK"),
};

const BY_CHAIN: Record<number, V3ChainConfig> = {
  [SEPOLIA.chainId]: SEPOLIA,
  [BASE.chainId]: BASE,
  [ARBITRUM.chainId]: ARBITRUM,
  [TEMPO_MODERATO.chainId]: TEMPO_MODERATO,
  [HYPEREVM_TESTNET.chainId]: HYPEREVM_TESTNET,
};

export function v3Config(chainId: number): V3ChainConfig | undefined {
  return BY_CHAIN[chainId];
}

/**
 * Chains whose deployed verifiers hold the PRODUCTION CEREMONY delta.
 *
 * A Groth16 phase-2 ceremony fixes `delta`, and a verifier only accepts proofs from the zkey it
 * was generated from. The circuits are identical across both key sets — alpha, beta, gamma and IC
 * all match byte for byte on-chain — so nothing about the witness or the public inputs tells you
 * which key set a chain wants. Only delta differs, and it differs silently: the browser proves,
 * verifies its own proof locally against its own vkey, passes, submits, and the kernel reverts
 * `ProofFailed()` from inside the relayer as an HTTP 502.
 *
 * Base runs the ceremony keys. Sepolia still runs the dev-beacon ones, and `VerifierRegistry` is
 * write-once per program version, so Sepolia cannot be re-pointed without a new stack. Until it
 * gets one, the browser has to carry both sets — exactly as the decryptor does per ChainPolicy.
 * When Sepolia is redeployed on ceremony keys, delete this set and the `/zk/ceremony` tree.
 */
// Arbitrum's 20 verifiers are byte-identical to Base's — same ceremony delta.
const CEREMONY_VERIFIER_CHAINS = new Set<number>([8453, 42161]);

/**
 * Base path for the PROVING artifacts (zkey + verification_key) this chain's verifiers accept.
 *
 * The `.wasm` is deliberately NOT scoped: it is the compiled circuit, identical across ceremonies,
 * and duplicating ~3 MB per circuit to say the same thing twice buys nothing. Only the zkey and
 * the vkey carry delta.
 */
export function zkProvingBase(chainId: number): string {
  return zkUrl(CEREMONY_VERIFIER_CHAINS.has(chainId) ? "/zk/ceremony" : "/zk");
}

/** True only when the core contracts for `chainId` are configured (non-zero). */
export function v3Deployed(chainId: number): boolean {
  const c = BY_CHAIN[chainId];
  return !!c && c.vaultKernel !== ZERO && c.complianceHub !== ZERO;
}

/**
 * Strategies are still v2-only — `multiLegBuilder` splits against `getNetwork(chainId).entrypoint`
 * and reads `localNoteStore`, neither of which knows about the v3 kernel. On a chain where v3 IS
 * live, deposits/balance/withdraw route to the kernel (UserDash.tsx:456/837/907) while arming would
 * still reach for v2 notes the user does not have — a silent "Have 0.0" after the arming fee and
 * the split tx have already been paid for.
 *
 * Routing strategies through v3 needs fire-time proving (the ASP roots are proof public inputs and
 * `ComplianceHub.admittedRootIsCurrent` demands the latest, so a proof built at arming is stale by
 * the time the trigger fires). Until that lands, fail loudly and early instead.
 */
export function strategiesSupported(chainId: number): boolean {
  // Either route will do: the v2 builder on a pre-v3 chain, or the v3 fire-time-proving builder
  // (strategyOrchestrateV3) where the kernel, executor and ASP are all configured.
  return v2StrategyPathSupported(chainId) || v3StrategiesLive(chainId);
}

/** True where the LEGACY v2 arming path is valid: it targets the v1 entrypoint and v2 notes. */
export function v2StrategyPathSupported(chainId: number): boolean {
  return !v3Deployed(chainId);
}

/** True where the v3 path can run end to end: kernel deployed AND executor + ASP reachable. */
export function v3StrategiesLive(chainId: number): boolean {
  const c = BY_CHAIN[chainId];
  return v3Deployed(chainId) && !!c?.executorUrl && !!c?.aspUrl;
}

/** Guard ANY arming path. Call BEFORE any on-chain side effect (fee, split, deposit). */
export function requireStrategySupport(chainId: number): void {
  if (!strategiesSupported(chainId)) {
    throw new Error(
      `Strategies are not available on this network yet: it runs the v3 vault, but the v3 ` +
        `strategy path is not fully configured (needs NEXT_PUBLIC_V3_*_EXECUTOR_URL and ` +
        `_ASP_URL). Deposit/withdraw work here regardless.`,
    );
  }
}

/** Guard the LEGACY v2 arming internals (split proof, v2 deposit). A v3 chain must never reach
 *  these: they would split a v2 note against a vault where the user holds nothing. */
export function requireV2StrategyPath(chainId: number): void {
  if (!v2StrategyPathSupported(chainId)) {
    throw new Error(
      `This network runs the v3 vault — the v2 arming path cannot be used here. ` +
        `Route through strategyOrchestrateV3 instead.`,
    );
  }
}

/** Throw a clear error if v3 is not yet deployed/configured for this chain. */
export function requireV3(chainId: number): V3ChainConfig {
  const c = BY_CHAIN[chainId];
  if (!c) throw new Error(`v3: unsupported chain ${chainId}`);
  if (!v3Deployed(chainId)) {
    throw new Error(
      `v3: contracts not deployed/configured for chain ${chainId} — set NEXT_PUBLIC_V3_* env`,
    );
  }
  return c;
}

/**
 * The id the browser arms enclave legs under, and the id the executor must prove with.
 *
 * It cannot be the strategy row id: the legs are sealed to the enclave BEFORE /createStrategy
 * exists to mint one. So the browser derives this, arms with it, and reports it back as the
 * payload's `arm_strategy_id`; the executor stores that and hands it to /spend/prove.
 *
 * The separator is `-`, not `:`. The enclave keys legs as `leg_key(strategyId, legIndex)`, which
 * FILTERS the id to [A-Za-z0-9_-] and then joins with ':' — a colon in the id is silently dropped,
 * so `<kernel>:<anchor>` and `<kernel><anchor>` collapse to the same key.
 */
export function v3ArmStrategyId(vaultKernel: string, scheduleAnchor: number): string {
  return `${vaultKernel}-${scheduleAnchor}`;
}
