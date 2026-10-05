/**
 * Home-chain catalog for the first-connect picker.
 * User picks once; Connect + dashboard vault follow that choice.
 */
import { SOLANA_DEVNET_CHAIN_ID } from "@/lib/chains/registry";
import { isDevnetClusterEnv } from "@/lib/chains/productGates";

export type HomeChainKind = "solana" | "evm" | "soon";

/** Capability chips under the chain name (not separate cards). */
export type HomeChainFeature =
  | "Native Vault"
  | "Routing"
  | "DEXs Integration"
  | "On/Off Ramp"
  | "Private Perps"
  | "Jupiter Earn"
  | "Jito Stake";

export type HomeChainOption = {
  /** Stable id used in localStorage + product mode. */
  id: string;
  /** Row title in the picker. */
  label: string;
  /** Network-mode pill next to the name (Devnet / Testnet only). */
  tag?: "Devnet" | "Testnet";
  /** What this home enables — shown as tags under the name. */
  features: readonly HomeChainFeature[];
  kind: HomeChainKind;
  /** Product chain id for ChainModeContext (only for active options). */
  productChainId?: string;
  /** networks.ts / wagmi numeric id (only for active options). */
  numericId?: number;
  /** Wallet the user will be asked to connect. */
  walletHint: string;
  /**
   * Bridged home chains: the vault is Base, and this LI.FI chain id is where the user sends and
   * receives — the default "Receive on" for withdrawals and source for funding.
   */
  edgeChainId?: number;
  /** Only NEXT_PUBLIC_ADMIN_WALLETS may use it; anyone else is sent back to the picker. */
  adminOnly?: boolean;
};

const HOME_CHAIN_STORAGE_KEY = "siphon.homeChainId";

/**
 * While true, an auto-reconnected EVM wallet (MetaMask on Base) must not replace the dashboard
 * chain. Set when the stored home is native Solana Devnet, or when this load calls
 * setSelectedChainId(900002). Cleared only by an explicit switch off Devnet.
 * null = not yet read from storage.
 */
let nativeSolanaDashLock: boolean | null = null;

export function nativeSolanaDashLocked(): boolean {
  if (nativeSolanaDashLock === null) {
    nativeSolanaDashLock =
      resolveHomeChainOption(readStoredHomeChainId())?.productChainId === "solana-devnet";
  }
  return nativeSolanaDashLock;
}

export function setNativeSolanaDashLock(locked: boolean): void {
  nativeSolanaDashLock = locked;
}

/** LI.FI's id for Solana (bridge/hub.ts SOLANA_LIFI_ID — not imported, it pulls in @solana/web3.js). */
export const SOLANA_EDGE_CHAIN_ID = 1151111081099710;

/** LI.FI Hyperliquid Core — fund inbound via HyperEVM (999). */
export const HYPERLIQUID_EDGE_CHAIN_ID = 1337;

/** A chain served from the Base vault through LI.FI — no native Siphon vault on the edge. */
function bridged(
  id: string,
  label: string,
  edgeChainId: number,
  features: readonly HomeChainFeature[],
  walletHint = "MetaMask / Rainbow",
): HomeChainOption {
  return {
    id,
    label,
    features,
    kind: "evm",
    productChainId: "base",
    numericId: 8453,
    edgeChainId,
    walletHint,
  };
}

/** Active + coming-soon rows for the connect picker. */
export function listHomeChainOptions(): HomeChainOption[] {
  const solanaDevnet = isDevnetClusterEnv();
  return [
    // Mainnet Solana is a bridged home: the vault (and the user's identity) is an EVM wallet on Base;
    // Phantom funds deposits and receives withdrawals. Devnet keeps its native Solana vault.
    solanaDevnet
      ? {
          id: "solana-devnet",
          label: "Solana",
          tag: "Devnet",
          // Meteora swaps + Jupiter Earn (USDC ↔ jlUSDC) on the native Devnet vault.
          features: ["Native Vault", "DEXs Integration", "Jupiter Earn"],
          kind: "solana",
          productChainId: "solana-devnet",
          numericId: SOLANA_DEVNET_CHAIN_ID,
          walletHint: "Phantom",
        }
      : bridged(
          "solana-mainnet",
          "Solana",
          SOLANA_EDGE_CHAIN_ID,
          ["Routing", "On/Off Ramp", "DEXs Integration"],
          "MetaMask / Rainbow + Phantom",
        ),
    {
      id: "arbitrum",
      label: "Arbitrum",
      features: ["Native Vault", "DEXs Integration"],
      kind: "evm",
      productChainId: "arbitrum",
      numericId: 42161,
      walletHint: "MetaMask / Rainbow",
    },
    {
      id: "base",
      label: "Base",
      features: ["Native Vault", "DEXs Integration"],
      kind: "evm",
      productChainId: "base",
      numericId: 8453,
      walletHint: "MetaMask / Rainbow",
    },
    // Tempo / Hyperliquid: testnet homes only (no mainnet connect cards yet).
    // --- Testnet homes (admin wallets only; ConnectButton turns anyone else back) ---
    {
      id: "sepolia",
      label: "ETH",
      tag: "Testnet",
      features: ["Native Vault", "DEXs Integration"],
      kind: "evm",
      productChainId: "sepolia",
      numericId: 11155111,
      walletHint: "MetaMask / Rainbow",
      adminOnly: true,
    },
    {
      id: "tempo-moderato",
      label: "Tempo",
      tag: "Testnet",
      features: ["On/Off Ramp"],
      kind: "evm",
      productChainId: "tempo-moderato",
      numericId: 42431,
      walletHint: "MetaMask / Rainbow",
      adminOnly: true,
    },
    {
      id: "hyperevm-testnet",
      label: "Hyperliquid",
      tag: "Testnet",
      features: ["Native Vault", "Private Perps"],
      kind: "evm",
      productChainId: "hyperevm-testnet",
      numericId: 998,
      walletHint: "MetaMask / Rainbow",
      adminOnly: true,
    },
    // Zcash stays reachable as a withdraw destination ("Receive on"), not a connectable home.
  ];
}

export function readStoredHomeChainId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(HOME_CHAIN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredHomeChainId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HOME_CHAIN_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
  setNativeSolanaDashLock(resolveHomeChainOption(id)?.productChainId === "solana-devnet");
  window.dispatchEvent(new CustomEvent("siphon:homeChainChanged", { detail: { id } }));
}

export function clearStoredHomeChainId(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(HOME_CHAIN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  setNativeSolanaDashLock(false);
}

/** LI.FI id of the stored home chain's edge, or null for a chain with its own vault. */
export function readHomeEdgeChainId(): number | null {
  return resolveHomeChainOption(readStoredHomeChainId())?.edgeChainId ?? null;
}

export function resolveHomeChainOption(id: string | null | undefined): HomeChainOption | null {
  if (!id) return null;
  // Legacy home ids removed from the picker.
  let resolvedId = id;
  if (id === "ethereum") resolvedId = "base";
  // Mainnet Tempo / Hyperliquid cards removed — send stored picks to their testnet homes.
  if (id === "tempo") resolvedId = "tempo-moderato";
  if (id === "hyperliquid") resolvedId = "hyperevm-testnet";
  return listHomeChainOptions().find((o) => o.id === resolvedId && o.kind !== "soon") ?? null;
}
