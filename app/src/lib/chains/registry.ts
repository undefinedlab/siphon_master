/**
 * Modular chain registry — Base (evm-v1) + Solana (solana-v1).
 * Adding a chain = new entry here + profile JSON + runtime adapters. Not a new ZK guest.
 */

export type SiphonRuntime = "evm-v1" | "solana-v1";

export type SiphonChain = {
  id: string;
  /** ASP / executor numeric id. Solana uses Siphon-assigned ids (not EVM). */
  numericId: number;
  label: string;
  runtime: SiphonRuntime;
  profileId: "evm-v1" | "solana-v1";
  nativeSymbol: string;
  /** Explorer base URL (optional). */
  explorer?: string;
};

/** Siphon-internal Solana ids (ASP/executor). Not Solana genesis hashes. */
export const SOLANA_MAINNET_CHAIN_ID = 900_001;
export const SOLANA_DEVNET_CHAIN_ID = 900_002;

export const CHAINS: Record<string, SiphonChain> = {
  base: {
    id: "base",
    numericId: 8453,
    label: "Base",
    runtime: "evm-v1",
    profileId: "evm-v1",
    nativeSymbol: "ETH",
    explorer: "https://basescan.org",
  },
  sepolia: {
    id: "sepolia",
    numericId: 11155111,
    label: "ETH Testnet",
    runtime: "evm-v1",
    profileId: "evm-v1",
    nativeSymbol: "ETH",
    explorer: "https://sepolia.etherscan.io",
  },
  /** Tempo Moderato — admin Tempo testnet home (DEX / Zones). */
  "tempo-moderato": {
    id: "tempo-moderato",
    numericId: 42431,
    label: "Tempo Testnet",
    runtime: "evm-v1",
    profileId: "evm-v1",
    nativeSymbol: "pathUSD",
    explorer: "https://explore.tempo.xyz",
  },
  /** Hyperliquid testnet (HyperEVM 998) — admin native vault for private perps E2E. */
  "hyperevm-testnet": {
    id: "hyperevm-testnet",
    numericId: 998,
    label: "Hyperliquid Testnet",
    runtime: "evm-v1",
    profileId: "evm-v1",
    nativeSymbol: "HYPE",
    explorer: "https://explorer.hyperliquid-testnet.xyz",
  },
  arbitrum: {
    id: "arbitrum",
    numericId: 42161,
    label: "Arbitrum One",
    runtime: "evm-v1",
    profileId: "evm-v1",
    nativeSymbol: "ETH",
    explorer: "https://arbiscan.io",
  },
  "solana-devnet": {
    id: "solana-devnet",
    numericId: SOLANA_DEVNET_CHAIN_ID,
    label: "Solana Devnet",
    runtime: "solana-v1",
    profileId: "solana-v1",
    nativeSymbol: "SOL",
    explorer: "https://explorer.solana.com/?cluster=devnet",
  },
  "solana-mainnet": {
    id: "solana-mainnet",
    numericId: SOLANA_MAINNET_CHAIN_ID,
    label: "Solana",
    runtime: "solana-v1",
    profileId: "solana-v1",
    nativeSymbol: "SOL",
    explorer: "https://explorer.solana.com",
  },
};

export function chainByNumericId(id: number): SiphonChain | undefined {
  return Object.values(CHAINS).find((c) => c.numericId === id);
}

export function isSolanaRuntime(chain: SiphonChain): boolean {
  return chain.runtime === "solana-v1";
}

export function isEvmRuntime(chain: SiphonChain): boolean {
  return chain.runtime === "evm-v1";
}
