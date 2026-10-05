// Central EVM network registry — single source of truth for chain + contract config.
// Hard ASP: same circuits/ABI on every chain; only addresses / RPC / chain id differ.
// Soft-era entrypoints are rejected at runtime by hardAspLive.ts until Hard ASP is deployed.

export interface NetworkConfig {
  chainId: number;
  hexChainId: string;
  name: string;
  shortName: string; // toggle label, e.g. "BASE" / "ETHEREUM"
  badgeLabel: string; // compact label for balance cards, e.g. "Sepolia" / "Base"
  entrypoint: string;
  weth: string;
  usdc: string;
  swapRouter: string;
  uniswapV3Factory?: string; // for resolving the swap pool (TWAP/grid leg SwapBinding)
  rpcUrl: string;
  explorer: string;
  deployBlock: number; // earliest block to scan for LeafInserted events
  // Vault generation this entrypoint belongs to. Sent as `vault_generation_id` on /createStrategy;
  // the executor fails closed (409) unless it equals its own ACTIVE_VAULT_GENERATION_<chainId>.
  // Bump together with `entrypoint` + `deployBlock` on every generation cutover.
  vaultGeneration?: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

export const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export const NETWORKS: Record<number, NetworkConfig> = {
  8453: {
    chainId: 8453,
    hexChainId: '0x2105',
    name: 'Base',
    shortName: 'BASE',
    badgeLabel: 'Base',
    entrypoint:
      process.env.NEXT_PUBLIC_ENTRYPOINT_ADDRESS?.trim() ||
      process.env.NEXT_PUBLIC_BASE_MAINNET_ENTRYPOINT?.trim() ||
      // Hard ASP R2 MPC deployment, 2026-08-21. The retired 0x5433995f… generation is retained
      // only in legacyMigration.ts as the recovery source.
      '0xA8AD713eDc27b14AA6057C53745479bc6a7E145A',
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    swapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
    uniswapV3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    deployBlock: parseInt(process.env.NEXT_PUBLIC_BASE_MAINNET_DEPLOY_BLOCK || '50240388', 10),
    vaultGeneration:
      process.env.NEXT_PUBLIC_BASE_MAINNET_VAULT_GENERATION?.trim() ||
      'base-hard-asp-r2-20260821',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  11155111: {
    chainId: 11155111,
    hexChainId: '0xaa36a7',
    name: 'ETH Testnet',
    shortName: 'ETH',
    badgeLabel: 'ETH',
    entrypoint:
      process.env.NEXT_PUBLIC_ETH_SEPOLIA_ENTRYPOINT?.trim() ||
      // greedy label scheme, 2026-08-20 — W/M verifiers inherit boundary/largest label (composite fold
      // removed) + latest-note-wins DepositInfo + Rule 1/2 revocation. Supersedes composite v5 0xf78aCfe9…
      '0x700d6116a4b14250a7a59421A399c2b86641C079',
    weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    swapRouter: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
    uniswapV3Factory: '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
    deployBlock: parseInt(process.env.NEXT_PUBLIC_ETH_SEPOLIA_DEPLOY_BLOCK || '11520601', 10),
    vaultGeneration:
      process.env.NEXT_PUBLIC_ETH_SEPOLIA_VAULT_GENERATION?.trim() ||
      'sepolia-hard-asp-v5-20260819',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  // v3-ONLY chain: the v5 VaultKernel is the vault (configV3.ts), and there is no v2 Entrypoint.
  // `entrypoint` is the zero address so any v2 path that is reached by mistake fails loudly on a
  // call to 0x0 instead of acting on some other chain's contract.
  42161: {
    chainId: 42161,
    hexChainId: '0xa4b1',
    name: 'Arbitrum One',
    shortName: 'ARBITRUM',
    badgeLabel: 'Arbitrum',
    entrypoint: '0x0000000000000000000000000000000000000000',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    swapRouter: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    uniswapV3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorer: 'https://arbiscan.io',
    // Real L2 block of the v5 deploy (Solidity block.number on Arbitrum is an L1 estimate).
    deployBlock: parseInt(process.env.NEXT_PUBLIC_V3_ARBITRUM_DEPLOY_BLOCK || '509682895', 10),
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  /**
   * Tempo Moderato (testnet) — admin home for Stablecoin DEX / Zones prototypes.
   * Mainnet Tempo home stays Base vault + LI.FI 4217 ramp.
   */
  42431: {
    chainId: 42431,
    hexChainId: '0xa5bf',
    name: 'Tempo Testnet',
    shortName: 'TEMPO',
    badgeLabel: 'Tempo',
    // v3-only once deployed (same pattern as Arbitrum): no v2 Entrypoint.
    entrypoint: '0x0000000000000000000000000000000000000000',
    // TIP-20 pathUSD — used for gas; there is no WETH on Tempo.
    weth: '0x20c0000000000000000000000000000000000000',
    usdc: '0x20c0000000000000000000000000000000000000',
    // Enshrined Stablecoin DEX (same address mainnet + Moderato).
    swapRouter: '0xdec0000000000000000000000000000000000000',
    rpcUrl:
      process.env.NEXT_PUBLIC_TEMPO_MODERATO_RPC?.trim() ||
      'https://rpc.moderato.tempo.xyz',
    explorer: 'https://explore.tempo.xyz',
    deployBlock: parseInt(process.env.NEXT_PUBLIC_TEMPO_MODERATO_DEPLOY_BLOCK || '0', 10),
    vaultGeneration:
      process.env.NEXT_PUBLIC_TEMPO_MODERATO_VAULT_GENERATION?.trim() ||
      'tempo-moderato-v3-pending',
    // MetaMask add-chain: Tempo reports PathUSD; protocol may use non-standard native decimals.
    nativeCurrency: { name: 'PathUSD', symbol: 'pathUSD', decimals: 18 },
  },
  /**
   * Hyperliquid testnet (HyperEVM 998) — admin-only native vault for private HL perps E2E.
   * Gas = HYPE (native). Vault asset = Circle USDC. Mainnet Hyperliquid home stays Base-bridged 1337.
   */
  998: {
    chainId: 998,
    hexChainId: '0x3e6',
    name: 'Hyperliquid Testnet',
    shortName: 'HYPERLIQUID',
    badgeLabel: 'Hyperliquid',
    entrypoint: '0x0000000000000000000000000000000000000000',
    // No WETH — native gas is HYPE; keep a zero sentinel so add-chain / tooling don't crash.
    weth: '0x0000000000000000000000000000000000000000',
    usdc: '0x2B3370eE501B4a559b57D449569354196457D8Ab',
    swapRouter: '0x0000000000000000000000000000000000000000',
    rpcUrl:
      process.env.NEXT_PUBLIC_HYPEREVM_TESTNET_RPC?.trim() ||
      'https://rpc.hyperliquid-testnet.xyz/evm',
    explorer: 'https://explorer.hyperliquid-testnet.xyz',
    deployBlock: parseInt(process.env.NEXT_PUBLIC_HYPEREVM_TESTNET_DEPLOY_BLOCK || '0', 10),
    vaultGeneration:
      process.env.NEXT_PUBLIC_HYPEREVM_TESTNET_VAULT_GENERATION?.trim() ||
      'hyperevm-testnet-v3-pending',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  },
  // Legacy — not in the chain toggle; kept so saved scenes / localStorage still resolve.
  84532: {
    chainId: 84532,
    hexChainId: '0x14a34',
    name: 'Base Sepolia',
    shortName: 'BASE-TEST',
    badgeLabel: 'Base Sepolia',
    entrypoint: '0xf7f2bEC39c3851012Ec722a6443F1979afEE4F9C',
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x036CBD53842c5426634E7929741cc1538ff7178E',
    swapRouter: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    deployBlock: parseInt(process.env.NEXT_PUBLIC_BASE_SEPOLIA_DEPLOY_BLOCK || '43273000', 10),
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  // Native Siphon vault on Solana Devnet — not an EVM L2 (no wallet_switchEthereumChain).
  // No v2 Entrypoint: use 0x0 (never `''` — ethers v6 treats empty strings as ENS names).
  900002: {
    chainId: 900002,
    hexChainId: '0xdbba2',
    name: 'Solana Devnet',
    shortName: 'SOL-DEV',
    badgeLabel: 'Solana Devnet',
    entrypoint: '0x0000000000000000000000000000000000000000',
    weth: 'So11111111111111111111111111111111111111112',
    usdc:
      process.env.NEXT_PUBLIC_SOLANA_USDC_MINT?.trim() ||
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    swapRouter: '0x0000000000000000000000000000000000000000',
    rpcUrl:
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com',
    explorer: 'https://explorer.solana.com/?cluster=devnet',
    deployBlock: 0,
    nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
  },
};

// Toggle reads BASE | ARBITRUM | ETHEREUM | TEMPO (admin) left-to-right (EVM surfaces only).
export const SUPPORTED_CHAIN_IDS = [8453, 42161, 11155111, 42431, 998];
/** Solana Devnet native vault chain id (not an EVM L2). */
export const SOLANA_DEVNET_UI_CHAIN_ID = 900_002;
/**
 * Product default custody chain:
 * - Devnet deploy (`NEXT_PUBLIC_CLUSTER=devnet`) → Solana Devnet (900002)
 * - otherwise → Arbitrum One (Solana mainnet fund door / EVM wrapper)
 */
export const DEFAULT_CHAIN_ID =
  (process.env.NEXT_PUBLIC_CLUSTER || "").toLowerCase() === "devnet"
    ? SOLANA_DEVNET_UI_CHAIN_ID
    : 42161;

// Admin-only chains (hidden unless wallet ∈ NEXT_PUBLIC_ADMIN_WALLETS).
// UI-only — list is public in the client bundle; never treat as real auth (see adminWalletCore.ts).
// Real spend enforcement is the executor's ADMIN_GATED_CHAIN_IDS, which already defaults to
// {11155111} in config.py and in both compose files. This re-aligns the UI with that: Sepolia was
// visible to everyone while the executor still refused non-allowlisted wallets, so a stranger hit
// no wall until they tried to ARM an order and then got a failure that reads as a broken strategy
// rather than "not for you". Hiding the toggle makes the two agree.
//
// Lisbon deliberately opened Sepolia to all wallets; that is what this reverts.
export const ADMIN_ONLY_CHAIN_IDS: number[] = [11155111, 42431, 998];

// Single source of truth — re-export so callers don't drift from adminWallet.ts.
export { isAdminWallet } from './adminWalletCore';
import { isAdminWallet } from './adminWalletCore';
import { activeEvmProvider } from './activeEvmProvider';
import { nativeSolanaDashLocked, readStoredHomeChainId, resolveHomeChainOption, setNativeSolanaDashLock } from '@/lib/chains/homeChains';
import { isDevnetClusterEnv } from '@/lib/chains/productGates';

/** Chains visible in the UI for this wallet (admin-only chains filtered). */
export function visibleChainIds(walletAddress?: string | null): number[] {
  const admin = isAdminWallet(walletAddress);
  return SUPPORTED_CHAIN_IDS.filter(
    (id) => admin || !ADMIN_ONLY_CHAIN_IDS.includes(id),
  );
}

export function isChainVisible(chainId: number, walletAddress?: string | null): boolean {
  return visibleChainIds(walletAddress).includes(chainId);
}

/** Hot-wallet addresses that pull funds from the vault during server-side execution.
 * MUST match the CVM order-signer's imported EVM key for that chain (GET /evm/address) —
 * the withdraw proof binds this as its recipient public input, so any mismatch makes every
 * execution fail InvalidZKProof() at preflight. Base = BASE_EXECUTOR_KEY (0x31c9…),
 * Sepolia = EVM_EXECUTOR_KEY fallback (0xc5b7…). */
const EXECUTOR_ADDRESSES: Record<number, string> = {
  8453:
    process.env.NEXT_PUBLIC_BASE_EXECUTOR_ADDRESS?.trim() ||
    '0x31c9a52Dc09D5c0e61256cA04156A528ecc63cf9',
  11155111:
    process.env.NEXT_PUBLIC_ETH_SEPOLIA_EXECUTOR_ADDRESS?.trim() ||
    '0xc5b7b574EE84A9B59B475FE32Eaf908C246d3859',
  // ARBITRUM_EXECUTOR_KEY on the Arbitrum box.
  42161:
    process.env.NEXT_PUBLIC_ARBITRUM_EXECUTOR_ADDRESS?.trim() ||
    '0xf9900C20AA5351Cc4f65529C216b657728b35517',
  // Set after Moderato executor wallet is provisioned.
  42431: process.env.NEXT_PUBLIC_TEMPO_MODERATO_EXECUTOR_ADDRESS?.trim() || '',
  // HyperEVM Testnet executor (same key family as HYPEREVM_TESTNET_EXECUTOR_KEY on the box).
  998: process.env.NEXT_PUBLIC_HYPEREVM_TESTNET_EXECUTOR_ADDRESS?.trim() || '',
};

/**
 * Recipient bound in the ZK withdraw proof for Pay & Run / builder strategies.
 * Must match the trade-executor wallet on that chain (funds land there, then swap → user).
 */
export function getZkWithdrawRecipient(chainId: number): string {
  const addr = EXECUTOR_ADDRESSES[chainId];
  if (!addr) {
    throw new Error(`No executor address configured for chain ${chainId}`);
  }
  return addr;
}

/** Labels for Pay & Run deposit / withdraw chain dropdowns. */
export const RUN_MODE_CHAIN_LABELS: string[] = [
  NETWORKS[11155111].name,
  NETWORKS[8453].name,
  NETWORKS[42161].name,
  NETWORKS[42431].name,
  NETWORKS[998].name,
];

const RUN_MODE_CHAIN_ALIASES: Record<string, number> = {
  base: 8453,
  arbitrum: 42161,
  'arbitrum one': 42161,
  'ethereum sepolia': 11155111,
  sepolia: 11155111,
  ethereum: 11155111,
  eth: 11155111,
  'eth testnet': 11155111,
  'tempo moderato': 42431,
  moderato: 42431,
  'tempo testnet': 42431,
  'hyperevm testnet': 998,
  hyperevm: 998,
  'hyperliquid testnet': 998,
  'hyper evm testnet': 998,
};

export function getRunModeChainLabel(chainId?: number): string {
  return getNetwork(chainId).name;
}

export function resolveRunModeChainId(label: string): number | null {
  const key = label.trim().toLowerCase();
  if (!key) return null;
  if (RUN_MODE_CHAIN_ALIASES[key] != null) return RUN_MODE_CHAIN_ALIASES[key];
  for (const id of SUPPORTED_CHAIN_IDS) {
    if (NETWORKS[id].name.toLowerCase() === key) return id;
  }
  return null;
}

/** Map builder / legacy labels (e.g. "Sepolia") to canonical run-mode names. */
export function normalizeRunModeChainLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return getRunModeChainLabel(getSelectedChainId());
  const id = resolveRunModeChainId(trimmed);
  return id != null ? NETWORKS[id].name : trimmed;
}

/** Run-summary label — clarifies mainnet vs testnet (e.g. Base → Base Mainnet). */
export function getRunModeChainDisplayLabel(label: string): string {
  const normalized = normalizeRunModeChainLabel(label);
  const id = resolveRunModeChainId(normalized);
  if (id === 8453) return "Base Mainnet";
  if (id === 42161) return "Arbitrum One";
  if (id === 11155111) return "ETH Testnet";
  if (id === 42431) return "Tempo Testnet";
  if (id === 998) return "Hyperliquid Testnet";
  if (id === 84532) return "Base Sepolia";
  return normalized;
}

const STORAGE_KEY = 'siphon.selectedChainId';

/** The chain the dapp is currently operating on (persisted in localStorage). */
/** Set when THIS page load picked Solana Devnet (the dashboard's Devnet toggle). */
let devnetPickedThisLoad = false;

export function getSelectedChainId(): number {
  if (typeof window !== 'undefined') {
    // Solana Devnet home (or an explicit Devnet pick this load) owns the vault. A Base id left
    // behind by MetaMask must not paint the dashboard as Base mainnet.
    if (nativeSolanaDashLocked()) return SOLANA_DEVNET_UI_CHAIN_ID;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const id = parseInt(stored, 10);
      // On a mainnet build the product chain always reloads onto the home vault, so a Devnet pick
      // stored by an earlier load would leave the header on Mainnet over chain 900002 (legacy
      // deposit path, signer pinned to Devnet). Devnet is honored only for the load that chose it.
      const staleDevnet = id === SOLANA_DEVNET_UI_CHAIN_ID && !isDevnetClusterEnv() && !devnetPickedThisLoad;
      if (NETWORKS[id] && !staleDevnet) return id;
      if (staleDevnet) {
        const home = resolveHomeChainOption(readStoredHomeChainId())?.numericId;
        if (home && NETWORKS[home] && home !== SOLANA_DEVNET_UI_CHAIN_ID) return home;
      }
    }
  }
  return DEFAULT_CHAIN_ID;
}

/** Set the active chain. Returns the resolved config. Emits a `siphon:chainChanged` event. */
export function setSelectedChainId(chainId: number): NetworkConfig {
  const cfg = NETWORKS[chainId];
  if (!cfg) throw new Error(`Unsupported chainId: ${chainId}`);
  if (typeof window !== 'undefined') {
    devnetPickedThisLoad = chainId === SOLANA_DEVNET_UI_CHAIN_ID;
    // 900002 engages the lock; any other explicit selection (the Mainnet button) releases it.
    // Automatic wallet chain events must not call this while the lock is held — see
    // installWalletChainSync and walletManager's chainChanged handler.
    setNativeSolanaDashLock(chainId === SOLANA_DEVNET_UI_CHAIN_ID);
    window.localStorage.setItem(STORAGE_KEY, String(chainId));
    window.dispatchEvent(new CustomEvent('siphon:chainChanged', { detail: { chainId } }));
  }
  return cfg;
}

/** Resolve a network config; defaults to the currently-selected chain. */
export function getNetwork(chainId?: number): NetworkConfig {
  const id = chainId ?? getSelectedChainId();
  const cfg = NETWORKS[id];
  if (!cfg) throw new Error(`Unsupported chainId: ${id}`);
  return cfg;
}

/**
 * URL for read-only JsonRpcProvider calls.
 * Browser → chain public RPC directly (avoids billing Vercel for every eth_call).
 * Server / SSR → same public gateway. Set NEXT_PUBLIC_RPC_PROXY=1 to route browser via /api/rpc.
 */
export function getReadProviderRpcUrl(chainId?: number): string {
  const id = chainId ?? getSelectedChainId();
  if (
    typeof window !== "undefined" &&
    process.env.NEXT_PUBLIC_RPC_PROXY !== "1"
  ) {
    return getNetwork(id).rpcUrl;
  }
  if (typeof window !== "undefined") {
    return `${window.location.origin}/api/rpc?chainId=${id}`;
  }
  return getNetwork(id).rpcUrl;
}

/** Map a chain to its supported token set (symbol → {address, decimals}). */
export function getTokens(chainId?: number): Record<string, { address: string; decimals: number; symbol: string }> {
  const id = chainId ?? getSelectedChainId();
  if (id === SOLANA_DEVNET_UI_CHAIN_ID) {
    const n = getNetwork(id);
    return {
      SOL: { address: n.weth, decimals: 9, symbol: 'SOL' },
      USDC: { address: n.usdc, decimals: 6, symbol: 'USDC' },
    };
  }
  // Tempo: TIP-20 stables only (no ETH). pathUSD is the vault + gas asset; Alpha/Beta for DEX demos.
  if (id === 42431) {
    const n = getNetwork(id);
    return {
      USDC: { address: n.usdc, decimals: 6, symbol: 'pathUSD' },
      PATHUSD: { address: n.usdc, decimals: 6, symbol: 'pathUSD' },
      ALPHAUSD: {
        address: '0x20c0000000000000000000000000000000000001',
        decimals: 6,
        symbol: 'AlphaUSD',
      },
      BETAUSD: {
        address: '0x20c0000000000000000000000000000000000002',
        decimals: 6,
        symbol: 'BetaUSD',
      },
    };
  }
  // HyperEVM Testnet: Circle USDC + native HYPE for gas (no ETH).
  if (id === 998) {
    const n = getNetwork(id);
    return {
      USDC: { address: n.usdc, decimals: 6, symbol: 'USDC' },
      HYPE: { address: NATIVE_TOKEN, decimals: 18, symbol: 'HYPE' },
    };
  }
  const n = getNetwork(id);
  return {
    ETH: { address: NATIVE_TOKEN, decimals: 18, symbol: 'ETH' },
    USDC: { address: n.usdc, decimals: 6, symbol: 'USDC' },
  };
}

/** Params for wallet_addEthereumChain when the wallet doesn't have the network yet. */
export function addChainParams(chainId?: number) {
  const n = getNetwork(chainId);
  return {
    chainId: n.hexChainId,
    chainName: n.name,
    nativeCurrency: n.nativeCurrency,
    rpcUrls: [n.rpcUrl],
    blockExplorerUrls: [n.explorer],
  };
}

type EthereumProvider = {
  request: (p: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

function walletErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Failed to switch network in wallet';
}

/** Prompt the connected wallet to switch (adding the chain if missing). */
export async function switchWalletNetwork(
  ethereum: EthereumProvider,
  chainId?: number,
): Promise<void> {
  const target = chainId ?? getSelectedChainId();
  // Solana custody is not an EIP-155 chain — never prompt MetaMask/RainbowKit.
  if (target === SOLANA_DEVNET_UI_CHAIN_ID) return;
  const n = getNetwork(target);
  try {
    await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: n.hexChainId }] });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 4902) {
      await ethereum.request({ method: 'wallet_addEthereumChain', params: [addChainParams(target)] });
    } else {
      throw err;
    }
  }
}

/** The chain the wallet reports, or NaN when it will not say. */
async function walletChainId(ethereum: EthereumProvider): Promise<number> {
  try {
    const v = await ethereum.request({ method: 'eth_chainId' });
    return typeof v === 'number' ? v : parseInt(String(v), 16);
  } catch {
    return NaN;
  }
}

export type SelectChainResult = { ok: true; chainId: number } | { ok: false; chainId: number; error: string };

/**
 * Switch the wallet to `chainId` (when available), then update dapp state.
 * If the wallet rejects the switch, dapp state is left unchanged.
 * Admin-only chains require an address in NEXT_PUBLIC_ADMIN_WALLETS.
 */
export async function selectChainAndSwitchWallet(
  chainId: number,
  walletAddress?: string | null,
): Promise<SelectChainResult> {
  const cfg = NETWORKS[chainId];
  if (!cfg) return { ok: false, chainId: getSelectedChainId(), error: `Unsupported chainId: ${chainId}` };

  if (ADMIN_ONLY_CHAIN_IDS.includes(chainId) && !isAdminWallet(walletAddress)) {
    return {
      ok: false,
      chainId: getSelectedChainId(),
      error: `${cfg.name} is admin-only — connect an admin wallet to use this network.`,
    };
  }

  const current = getSelectedChainId();

  // Solana Devnet: update app state only — never wallet_switchEthereumChain.
  if (chainId === SOLANA_DEVNET_UI_CHAIN_ID) {
    setSelectedChainId(chainId);
    return { ok: true, chainId };
  }

  // The wallet the user connected through, not whichever extension owns window.ethereum.
  // Switching the WRONG wallet is silent and leaves the app claiming a chain the signer is not
  // on — the state that let a compliance fee be quoted and paid on the wrong network.
  const eth = activeEvmProvider() as EthereumProvider | null;

  // "Already selected" is the app's belief, not the wallet's: the stored chain survives reloads
  // and wallet-side switches, so trusting it made the button a silent no-op while the wallet sat
  // on another network. Skip the prompt only when the wallet itself reports the target.
  if (chainId === current && (!eth || (await walletChainId(eth)) === chainId)) {
    return { ok: true, chainId };
  }

  if (eth) {
    try {
      await switchWalletNetwork(eth, chainId);
    } catch (err: unknown) {
      return { ok: false, chainId: current, error: walletErrorMessage(err) };
    }
  }

  setSelectedChainId(chainId);
  return { ok: true, chainId };
}

let walletChainSyncInstalled = false;

/** Keep dapp selected chain in sync when the user switches networks in their wallet. */
export function installWalletChainSync(): void {
  if (typeof window === 'undefined' || walletChainSyncInstalled) return;
  const eth = activeEvmProvider() as EthereumProvider | null;
  if (!eth?.on) return;

  const onChainChanged = (hexChainId: unknown) => {
    const id = typeof hexChainId === 'string' ? parseInt(hexChainId, 16) : NaN;
    if (nativeSolanaDashLocked()) return;
    if (!NETWORKS[id] || id === getSelectedChainId()) return;
    setSelectedChainId(id);
    window.dispatchEvent(new CustomEvent('siphon:walletChainChanged', { detail: { chainId: id } }));
  };

  eth.on('chainChanged', onChainChanged);
  walletChainSyncInstalled = true;
}
