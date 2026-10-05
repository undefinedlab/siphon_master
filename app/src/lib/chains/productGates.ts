/**
 * Product gates for Solana modes.
 *
 * - Solana mainnet: Phantom USDC → Li.Fi → Arbitrum (42161) vault (EVM wrapper).
 * - Solana Devnet: native Siphon vault on Solana (chain id 900002) — hackathon BPF MVP.
 */
import {
  CHAINS,
  isSolanaRuntime,
  SOLANA_DEVNET_CHAIN_ID,
  type SiphonChain,
} from "@/lib/chains/registry";

export const BASE_VAULT_CHAIN_ID = 8453;
export const ARBITRUM_VAULT_CHAIN_ID = 42161;

/**
 * Legacy Sepolia custody id (wrapper era). Devnet product no longer uses this for vault custody.
 * Kept for env/docs that still mention Sepolia test bridges.
 */
export const DEVNET_VAULT_CHAIN_ID = (() => {
  const raw = (process.env.NEXT_PUBLIC_DEVNET_VAULT_CHAIN_ID || String(SOLANA_DEVNET_CHAIN_ID)).trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : SOLANA_DEVNET_CHAIN_ID;
})();

/** True when this product mode must not call EVM depositV3 / vault RPCs. */
export function forbidsEvmVaultCalls(chain: SiphonChain): boolean {
  return chain.id === "solana-devnet";
}

export function isDevnetProduct(chain: SiphonChain): boolean {
  return chain.id === "solana-devnet";
}

/** Build-time / env gate — true on the Solana Devnet Railway/app deploy. */
export function isDevnetClusterEnv(): boolean {
  return (process.env.NEXT_PUBLIC_CLUSTER || "").toLowerCase() === "devnet";
}

/** True when Solana mainnet (or Base/Arb) funds an EVM vault. Devnet is native Solana. */
export function targetsEvmVaultCustody(chain: SiphonChain): boolean {
  if (chain.id === "solana-devnet") return false;
  return (
    chain.id === "solana-mainnet" ||
    chain.numericId === BASE_VAULT_CHAIN_ID ||
    chain.numericId === ARBITRUM_VAULT_CHAIN_ID
  );
}

/** @deprecated Prefer targetsEvmVaultCustody */
export function targetsBaseVaultCustody(chain: SiphonChain): boolean {
  return targetsEvmVaultCustody(chain);
}

/** Custody chain id for notes / deposit routing. */
export function vaultCustodyChainId(chain: SiphonChain): number {
  if (chain.id === "solana-devnet") return SOLANA_DEVNET_CHAIN_ID;
  if (chain.id === "solana-mainnet") return ARBITRUM_VAULT_CHAIN_ID;
  return chain.numericId;
}

export function productChainById(id: string): SiphonChain {
  const chain = CHAINS[id];
  if (!chain) throw new Error(`unknown product chain id: ${id}`);
  return chain;
}

/** Mainnet Solana wrapper must target Arbitrum EVM vault. */
export function assertSolanaModeTargetsEvmVault(chain: SiphonChain): void {
  if (chain.id !== "solana-mainnet") {
    throw new Error(`expected solana-mainnet for EVM-vault wrapper; got ${chain.id}`);
  }
  if (!isSolanaRuntime(chain)) {
    throw new Error(`expected solana-v1 runtime; got ${chain.runtime}`);
  }
  const custody = vaultCustodyChainId(chain);
  if (custody !== ARBITRUM_VAULT_CHAIN_ID) {
    throw new Error(`expected vault custody ${ARBITRUM_VAULT_CHAIN_ID}; got ${custody}`);
  }
  if (forbidsEvmVaultCalls(chain)) {
    throw new Error("Solana mainnet wrapper must allow EVM vault calls");
  }
}

/** Devnet native Solana vault custody. */
export function assertSolanaDevnetNativeVault(chain: SiphonChain): void {
  if (chain.id !== "solana-devnet") {
    throw new Error(`expected solana-devnet; got ${chain.id}`);
  }
  if (!isSolanaRuntime(chain)) {
    throw new Error(`expected solana-v1 runtime; got ${chain.runtime}`);
  }
  const custody = vaultCustodyChainId(chain);
  if (custody !== SOLANA_DEVNET_CHAIN_ID) {
    throw new Error(`expected Solana Devnet custody ${SOLANA_DEVNET_CHAIN_ID}; got ${custody}`);
  }
  if (!forbidsEvmVaultCalls(chain)) {
    throw new Error("Solana Devnet must forbid EVM vault calls");
  }
}

/** @deprecated Prefer assertSolanaModeTargetsEvmVault / assertSolanaDevnetNativeVault */
export function assertSolanaModeTargetsBaseVault(chain: SiphonChain): void {
  if (chain.id === "solana-devnet") {
    assertSolanaDevnetNativeVault(chain);
    return;
  }
  assertSolanaModeTargetsEvmVault(chain);
}

/** @deprecated */
export function assertSolanaModeBlocksEvmVault(chain: SiphonChain): void {
  assertSolanaDevnetNativeVault(chain);
}
