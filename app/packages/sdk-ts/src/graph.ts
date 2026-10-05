/**
 * Vault-index (Ponder → trade-executor `/vault-index/*`) helpers for Builder / MCP.
 *
 * No The Graph protocol. Anonymity + recent swaps come from REST vault-index only.
 *
 * Env:
 *   VAULT_INDEX_URL | NEXT_PUBLIC_VAULT_INDEX_URL
 *   SIPHON_BASE_URL          → `${base}/vault-index`
 *   TRADE_EXECUTOR_URL | NEXT_PUBLIC_TRADE_EXECUTOR_URL  (default host fallback)
 *   GRAPH_ARM_FAIL_CLOSED=true|false   (name kept for env compat; gates vault-index reads)
 *   GRAPH_ARM_FORCE_ALLOWED=true       (MCP createStrategy force override)
 */

/** WETH / USDC on Base — retained for callers that map symbols → addresses. */
export const BASE_WETH = "0x4200000000000000000000000000000000000006";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const MAX_SWAP_QUERY_LIMIT = 50;

/** @deprecated The Graph subgraphs are removed; only "ponder" | "none" are produced. */
export type GraphSource = "siphon_subgraph" | "uniswap_subgraph" | "ponder" | "v5_indexer" | "none";

export interface AnonymitySetResult {
  chainId: number;
  asset: string;
  /** All merkle leaves (deposits + change notes). Do not treat as unique users. */
  leafCount: number;
  depositCount: number | null;
  swapCount: number | null;
  lastLeafAt: number | null;
  /**
   * Prefer depositCount when known; else leafCount. Agents should cite this with
   * the caveat that leafCount overstates unique depositors.
   */
  privacyMetric: number;
  privacyMetricKind: "depositCount" | "leafCount" | "unavailable";
  source: GraphSource;
}

export interface VaultSwapRow {
  id: string;
  asset: string;
  recipient: string;
  pool: string;
  amountIn: string;
  minAmountOut: string;
  blockTimestamp: number;
  txHash: string;
}

/** Kept for API/MCP shape compat — always empty (no Uniswap The Graph). */
export interface PoolDepthResult {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  poolId: string | null;
  feeTier: string | null;
  liquidity: string | null;
  totalValueLockedUSD: string | null;
  volumeUSD: string | null;
  source: GraphSource;
  warning: string | null;
}

export interface ArmAssessment {
  ok: boolean;
  shouldWarn: boolean;
  shouldBlock: boolean;
  reasons: string[];
  anonymity: AnonymitySetResult | null;
  pool: PoolDepthResult | null;
  failClosed: boolean;
}

function env(name: string, ...alts: string[]): string {
  const keys = [name, ...alts];
  for (const k of keys) {
    const v = (typeof process !== "undefined" ? process.env[k] : undefined)?.trim();
    if (v) return v;
  }
  return "";
}

function isProductionRuntime(): boolean {
  const v = env("VERCEL_ENV", "NODE_ENV").toLowerCase();
  return v === "production" || v === "prod";
}

/** Default fail-closed in production; override with GRAPH_ARM_FAIL_CLOSED=false. */
export function armFailClosedEnabled(): boolean {
  const raw = env("GRAPH_ARM_FAIL_CLOSED").toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off") return false;
  if (raw === "true" || raw === "1" || raw === "on") return true;
  return isProductionRuntime();
}

/** MCP force= override — off unless explicitly enabled. */
export function armForceAllowed(): boolean {
  const raw = env("GRAPH_ARM_FORCE_ALLOWED", "SIPHON_ALLOW_ARM_FORCE").toLowerCase();
  return raw === "true" || raw === "1" || raw === "on";
}

/** Same default host as the app's tradeExecutorClient. */
const DEFAULT_TRADE_EXECUTOR_URL = "https://54-221-134-175.sslip.io";

function vaultIndexBase(): string {
  const custom = env("VAULT_INDEX_URL", "NEXT_PUBLIC_VAULT_INDEX_URL");
  if (custom) return custom.replace(/\/+$/, "");
  const base = env("SIPHON_BASE_URL");
  if (base) return `${base.replace(/\/+$/, "")}/vault-index`;
  const te = env("TRADE_EXECUTOR_URL", "NEXT_PUBLIC_TRADE_EXECUTOR_URL") || DEFAULT_TRADE_EXECUTOR_URL;
  return `${te.replace(/\/+$/, "")}/vault-index`;
}

/** The v2 indexer for a v5 chain (the app's NEXT_PUBLIC_V3_*_INDEXER_URL). */
function v5IndexerBase(chainId: number): string {
  const key: Record<number, string> = {
    8453: "NEXT_PUBLIC_V3_BASE_INDEXER_URL",
    42161: "NEXT_PUBLIC_V3_ARBITRUM_INDEXER_URL",
    11155111: "NEXT_PUBLIC_V3_SEPOLIA_INDEXER_URL",
  };
  return key[chainId] ? env(key[chainId]).replace(/\/+$/, "") : "";
}

const MIN_ANONYMITY_WARN = 20;
/** Block only when the set is empty; warn below MIN_ANONYMITY_WARN during early bootstrap. */
const MIN_ANONYMITY_BLOCK = 1;

function withPrivacyMetric(
  base: Omit<AnonymitySetResult, "privacyMetric" | "privacyMetricKind">,
): AnonymitySetResult {
  if (base.source === "none") {
    return { ...base, privacyMetric: 0, privacyMetricKind: "unavailable" };
  }
  // Prefer depositCount when positive. Zero often means deposit rows are not indexed yet.
  if (
    typeof base.depositCount === "number" &&
    Number.isFinite(base.depositCount) &&
    base.depositCount > 0
  ) {
    return {
      ...base,
      privacyMetric: base.depositCount,
      privacyMetricKind: "depositCount",
    };
  }
  return {
    ...base,
    privacyMetric: base.leafCount,
    privacyMetricKind: "leafCount",
  };
}

export async function getAnonymitySet(
  chainId: number,
  asset: string,
): Promise<AnonymitySetResult> {
  const symbol = asset.toUpperCase();
  const idx = vaultIndexBase();

  if (idx) {
    try {
      const res = await fetch(
        `${idx}/anonymity-set?chainId=${chainId}&asset=${encodeURIComponent(symbol)}`,
      );
      if (res.ok) {
        const j = (await res.json()) as {
          leafCount?: number;
          depositCount?: number;
          swapCount?: number;
          lastLeafAt?: number | null;
        };
        if (typeof j.leafCount === "number") {
          return withPrivacyMetric({
            chainId,
            asset: symbol,
            leafCount: j.leafCount,
            depositCount: typeof j.depositCount === "number" ? j.depositCount : null,
            swapCount: typeof j.swapCount === "number" ? j.swapCount : null,
            lastLeafAt: j.lastLeafAt ?? null,
            source: "ponder",
          });
        }
      }
      const leavesRes = await fetch(
        `${idx}/leaves?chainId=${chainId}&asset=${encodeURIComponent(symbol)}`,
      );
      if (leavesRes.ok) {
        const j = (await leavesRes.json()) as { count?: number; leaves?: unknown[] };
        const count =
          typeof j.count === "number"
            ? j.count
            : Array.isArray(j.leaves)
              ? j.leaves.length
              : 0;
        return withPrivacyMetric({
          chainId,
          asset: symbol,
          leafCount: count,
          depositCount: null,
          swapCount: null,
          lastLeafAt: null,
          source: "ponder",
        });
      }
    } catch {
      /* fall through */
    }
  }

  // v5 vaults: /vault-index is the retired v1 Ponder lane (503 since the 2026-10 move), so the
  // arm gate failed closed on every chain. The v2 indexer serves the kernel's leaf set directly.
  // One tree holds every asset, so this is the whole pool's leaf count (change notes included) —
  // reported as leafCount, which the caller already flags as an overestimate.
  const v5 = v5IndexerBase(chainId);
  if (v5) {
    try {
      const res = await fetch(`${v5}/state/leaves?chainId=${chainId}&limit=1`);
      if (res.ok) {
        const j = (await res.json()) as { available?: boolean; totalCount?: number };
        if (j.available !== false && typeof j.totalCount === "number") {
          return withPrivacyMetric({
            chainId,
            asset: symbol,
            leafCount: j.totalCount,
            depositCount: null,
            swapCount: null,
            lastLeafAt: null,
            source: "v5_indexer",
          });
        }
      }
    } catch {
      /* fall through */
    }
  }

  return withPrivacyMetric({
    chainId,
    asset: symbol,
    leafCount: 0,
    depositCount: null,
    swapCount: null,
    lastLeafAt: null,
    source: "none",
  });
}

export async function getRecentVaultSwaps(
  chainId: number,
  first = 10,
): Promise<{ swaps: VaultSwapRow[]; source: GraphSource }> {
  const limit = Math.min(Math.max(1, Number(first) || 10), MAX_SWAP_QUERY_LIMIT);
  const idx = vaultIndexBase();
  if (idx) {
    try {
      const res = await fetch(`${idx}/swaps?chainId=${chainId}&limit=${limit}`);
      if (res.ok) {
        const j = (await res.json()) as { swaps?: VaultSwapRow[] };
        if (Array.isArray(j.swaps)) {
          return { swaps: j.swaps.slice(0, limit), source: "ponder" };
        }
      }
    } catch {
      /* fall through */
    }
  }

  return { swaps: [], source: "none" };
}

/**
 * Uniswap pool depth via The Graph was removed. Stub kept so MCP /api/graph shapes stay stable.
 */
export async function getUniswapPoolDepth(
  chainId: number,
  tokenInSymbol: string,
  tokenOutSymbol: string,
): Promise<PoolDepthResult> {
  return {
    chainId,
    tokenIn: tokenInSymbol,
    tokenOut: tokenOutSymbol,
    poolId: null,
    feeTier: null,
    liquidity: null,
    totalValueLockedUSD: null,
    volumeUSD: null,
    source: "none",
    warning: "Uniswap pool depth via The Graph is not used — vault-index only",
  };
}

/**
 * Arm gate: vault-index anonymity only (Ponder REST). No The Graph / Uniswap subgraph.
 */
export async function assessStrategyArming(input: {
  chainId: number;
  fromAsset: string;
  toAsset?: string | null;
  includeSwap?: boolean;
  /** Override env GRAPH_ARM_FAIL_CLOSED for this call. */
  failClosed?: boolean;
}): Promise<ArmAssessment> {
  const reasons: string[] = [];
  const failClosed = input.failClosed ?? armFailClosedEnabled();
  const anonymity = await getAnonymitySet(input.chainId, input.fromAsset);

  if (anonymity.source === "none") {
    reasons.push(
      failClosed
        ? "BLOCK: no anonymity-set data (fail-closed). Ensure trade-executor /vault-index is reachable."
        : "No anonymity-set data (ensure trade-executor /vault-index is reachable)",
    );
  } else {
    const metric = anonymity.privacyMetric;
    const kind = anonymity.privacyMetricKind;
    if (kind === "leafCount") {
      reasons.push(
        `Privacy metric uses leafCount=${anonymity.leafCount} (includes change notes — overstates unique depositors). Prefer depositCount when indexed.`,
      );
    } else {
      reasons.push(
        `Privacy metric depositCount=${anonymity.depositCount} (leafCount=${anonymity.leafCount} includes change notes) via ${anonymity.source}`,
      );
    }

    if (metric < MIN_ANONYMITY_BLOCK) {
      reasons.push(
        `Anonymity critically small: ${kind}=${metric} for ${input.fromAsset} on chain ${input.chainId}`,
      );
    } else if (metric < MIN_ANONYMITY_WARN) {
      reasons.push(
        `Anonymity small: ${kind}=${metric} — privacy weaker (${anonymity.source})`,
      );
    }
  }

  const wantsSwap =
    input.includeSwap !== false &&
    !!input.toAsset &&
    input.toAsset.toUpperCase() !== input.fromAsset.toUpperCase();

  // Pool depth intentionally unused (no The Graph). Keep null so callers ignore TVL gates.
  const pool: PoolDepthResult | null = wantsSwap
    ? await getUniswapPoolDepth(input.chainId, input.fromAsset, input.toAsset!)
    : null;

  const anonymityTooSmall =
    anonymity.source !== "none" && anonymity.privacyMetric < MIN_ANONYMITY_BLOCK;
  const anonymityMissing = anonymity.source === "none";

  const shouldBlock = anonymityTooSmall || (failClosed && anonymityMissing);

  const shouldWarn =
    !shouldBlock &&
    ((anonymity.source !== "none" && anonymity.privacyMetric < MIN_ANONYMITY_WARN) ||
      anonymity.source === "none");

  return {
    ok: !shouldBlock,
    shouldWarn,
    shouldBlock,
    reasons,
    anonymity,
    pool,
    failClosed,
  };
}
