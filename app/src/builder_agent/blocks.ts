import type { StrategyKind } from "../lib/strategySpec";
import { getNetwork, getSelectedChainId, SOLANA_DEVNET_UI_CHAIN_ID } from "../lib/networks";
import type { BlockType } from "./types";

export const SUPPORTED_TOKENS = ["ETH", "USDC", "SOL", "USDT", "WBTC", "XMR"] as const;

/** @deprecated Prefer `activeTokensForChain()` — kept for callers that assume EVM defaults. */
export const ACTIVE_TOKENS = ["ETH", "USDC"] as const;

export const SOLANA_MAINNET_UI_CHAIN_ID = 900_001;

export type BuilderChainKind = "solana" | "evm";

export type BuilderChainProfile = {
  kind: BuilderChainKind;
  /** Runnable deposit/swap tokens for this chain. */
  activeTokens: readonly string[];
  /** All swap venues shown in the picker (includes coming-soon / inactive). */
  swapDexes: readonly string[];
  /** Venues that are actually wired and selectable today. */
  activeSwapDexes: readonly string[];
  /** Soft default — always one of activeSwapDexes. */
  preferredDex: string;
  /** Volatile / native side used in suggestion copy (ETH or SOL). */
  primaryToken: string;
  /** Stable side used in suggestion copy (usually USDC). */
  quoteToken: string;
};

export type BuilderChainOpts = {
  chainId?: number;
  /** Home-chain picker id (e.g. solana-mainnet) — Solana UX even when vault is Base-bridged. */
  homeChainId?: string | null;
};

function readHomeChainIdFallback(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem("siphon.homeChainId");
  } catch {
    return null;
  }
}

/** True when the builder should speak Solana tokens / DEXes. */
export function isSolanaBuilderContext(opts?: BuilderChainOpts): boolean {
  const chainId = opts?.chainId ?? (typeof window !== "undefined" ? getSelectedChainId() : undefined);
  const home = opts?.homeChainId ?? readHomeChainIdFallback();
  if (
    chainId === SOLANA_DEVNET_UI_CHAIN_ID ||
    chainId === SOLANA_MAINNET_UI_CHAIN_ID
  ) {
    return true;
  }
  return home === "solana-devnet" || home === "solana-mainnet";
}

export function builderChainProfile(opts?: BuilderChainOpts): BuilderChainProfile {
  if (isSolanaBuilderContext(opts)) {
    // Swaps settle on Meteora DLMM; Jupiter Earn is a separate Lend/Earn block (USDC ↔ jlUSDC).
    // Jupiter / Raydium / Orca stay visible in the swap picker but inactive for swaps.
    return {
      kind: "solana",
      // jlUSDC / JitoSOL = Earn / stake shares; swap pairs: USDC↔SOL, jlUSDC↔SOL, JitoSOL↔SOL.
      activeTokens: ["SOL", "USDC", "jlUSDC", "JitoSOL"],
      swapDexes: ["Meteora", "Jupiter", "Raydium", "Orca"],
      activeSwapDexes: ["Meteora"],
      preferredDex: "Meteora",
      primaryToken: "SOL",
      quoteToken: "USDC",
    };
  }
  return {
    kind: "evm",
    activeTokens: ["ETH", "USDC"],
    swapDexes: ["Uniswap"],
    activeSwapDexes: ["Uniswap"],
    preferredDex: "Uniswap",
    primaryToken: "ETH",
    quoteToken: "USDC",
  };
}

export function activeTokensForChain(opts?: BuilderChainOpts): readonly string[] {
  return builderChainProfile(opts).activeTokens;
}

export function swapDexesForChain(opts?: BuilderChainOpts): readonly string[] {
  return builderChainProfile(opts).swapDexes;
}

export function activeSwapDexesForChain(opts?: BuilderChainOpts): readonly string[] {
  return builderChainProfile(opts).activeSwapDexes;
}

export function isDexActive(dex: string, opts?: BuilderChainOpts): boolean {
  return activeSwapDexesForChain(opts).some((d) => d.toLowerCase() === dex.trim().toLowerCase());
}

/** Default DEX when a single active venue exists; null when the user must choose. */
export function defaultDexForChain(opts?: BuilderChainOpts): string | null {
  const profile = builderChainProfile(opts);
  return profile.activeSwapDexes.length === 1 ? profile.preferredDex : null;
}

export function normalizeDex(
  raw: string | null | undefined,
  opts?: BuilderChainOpts,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Only active venues normalize — inactive labels (Jupiter on Solana) do not stick.
  const match = activeSwapDexesForChain(opts).find(
    (dex) => dex.toLowerCase() === trimmed.toLowerCase(),
  );
  return match ?? null;
}

/** @deprecated Prefer `defaultDexForChain()` / `builderChainProfile().preferredDex`. */
export const DEFAULT_DEX = "Uniswap";

// Read per call, not at load: DEFAULT_CHAIN_ID is Arbitrum on mainnet builds, so a load-time constant
// built Base-home strategies on Arbitrum and RUN switched the wallet there.
export const defaultChainLabel = (): string => getNetwork(getSelectedChainId()).badgeLabel;

export const CANONICAL_FLOW: BlockType[] = ["deposit", "bridge", "strategy", "swap", "lend", "withdraw"];

export const STRATEGY_KEYWORDS: Array<{ kind: StrategyKind; patterns: RegExp[] }> = [
  {
    kind: "Perps",
    patterns: [
      /\bhyperliquid\b/i,
      /\bperps?\b/i,
      /\blong\s+(?:btc|eth|sol|hype)\b/i,
      /\bshort\s+(?:btc|eth|sol|hype)\b/i,
      /\bleverage\b/i,
      /\b\dx\s+(?:long|short)\b/i,
    ],
  },
  {
    // First so bet-shaped prompts don't fall through to Limit Order ("at $50", "when odds…").
    kind: "Predictions",
    patterns: [
      /\bpolymarket\b/i,
      /\bprediction\s*markets?\b/i,
      /\bbet\s+(?:\$?\d|on\b)/i,
      /\bwager\b/i,
      /\bodds\b/i,
    ],
  },
  {
    kind: "Stop Loss",
    patterns: [/\bstop[\s-]?loss\b/i, /\bstop\s+out\b/i, /\bprotect\s+downside\b/i],
  },
  {
    kind: "Take Profit",
    patterns: [
      /\btake[\s-]?profit\b/i,
      /\bprofit\s+target\b/i,
      /\block\s+in\s+gains\b/i,
      /\bsell\s+rally\b/i,
      /\bsell\s+when\b/i,
    ],
  },
  {
    kind: "Range",
    patterns: [/\brange\b/i, /\bgrid\b/i, /\bbetween\s+\$?\d/i, /\bprice\s+band\b/i],
  },
  {
    kind: "TWAP",
    patterns: [/\btwap\b/i, /\btime[\s-]?weighted\b/i, /\bover\s+\d+\s*(?:min|hour|h)/i, /\bslices?\b/i],
  },
  {
    kind: "Limit Order",
    patterns: [
      /\blimit\b/i,
      /\bwhen\s+price\b/i,
      /\bat\s+\$?\d/i,
      /\bprice\s+hits?\b/i,
      /\bbuy\s+(?:the\s+)?dip\b/i,
    ],
  },
];

/** Prompts that should build Deposit → Loop (swap/withdraw), not a DCA Strategy block. */
export const RECURRING_FLOW_PATTERNS: RegExp[] = [
  /\bdca\b/i,
  /\bdollar[\s-]?cost\b/i,
  /\brecurring\b/i,
  /\bon\s+a\s+cadence\b/i,
  /\buntil\s+funds\b/i,
  /\bevery\s+\d+/i,
];

export function isRecurringFlowPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  if (/\btwap\b/i.test(lower) || /\bslices?\b/i.test(lower)) return false;
  return RECURRING_FLOW_PATTERNS.some((pattern) => pattern.test(prompt));
}

export function isActiveToken(symbol: string, opts?: BuilderChainOpts): boolean {
  return activeTokensForChain(opts).includes(symbol.toUpperCase());
}

export function normalizeToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const upper = raw.toUpperCase();
  return SUPPORTED_TOKENS.includes(upper as (typeof SUPPORTED_TOKENS)[number]) ? upper : null;
}

/** Pull a named swap venue out of free text when it matches an active venue on this chain. */
export function extractDexFromText(
  text: string,
  opts?: BuilderChainOpts,
): string | null {
  const lower = text.toLowerCase();
  for (const dex of activeSwapDexesForChain(opts)) {
    if (lower.includes(dex.toLowerCase())) return dex;
  }
  return null;
}
