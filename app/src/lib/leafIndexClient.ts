/**
 * Client for the indexed on-chain vault state (siphon-indexer → Postgres → trade-executor
 * /vault-index/*). Replaces the browser's chunked eth_getLogs scans with HTTP reads.
 *
 * Every function returns null on ANY miss/error — callers (zkHandler) fall back to the legacy
 * RPC log scan, so a down/lagging indexer degrades to the old (slower) behavior, never breaks.
 *
 * Leaves API supports incremental sync via fromIndex (P1). Never requests a path by leaf index
 * (that would leak which note the user is about to spend).
 */
import { getTradeExecutorBaseUrl } from "./tradeExecutorClient";
import { NATIVE_TOKEN, getTokens, getNetwork } from "./networks";
import type { LeavesPage } from "./merkleLeafCache";

/** Skip the indexer for a while after a failure so a dead endpoint isn't hammered per poll. */
const FAILURE_BACKOFF_MS = 60_000;
let indexerDownUntil = 0;

function indexerAvailable(): boolean {
  return Date.now() >= indexerDownUntil;
}

function markIndexerDown(): void {
  indexerDownUntil = Date.now() + FAILURE_BACKOFF_MS;
}

/** Test helper — reset backoff between unit tests. */
export function __resetIndexerBackoffForTests(): void {
  indexerDownUntil = 0;
}

function headers(): HeadersInit {
  // Read proxy is public/rate-limited. Never ship an API credential in the browser bundle.
  return { Accept: "application/json" };
}

/**
 * Base URL that serves /leaves and /deposits. Default: the trade-executor proxy
 * (…/vault-index/leaves). Override with NEXT_PUBLIC_VAULT_INDEX_URL to hit a Ponder
 * instance directly (it serves the same routes at its root, e.g. http://localhost:42069).
 */
function vaultIndexBase(): string {
  const custom = (process.env.NEXT_PUBLIC_VAULT_INDEX_URL || "").replace(/\/+$/, "");
  return custom || `${getTradeExecutorBaseUrl()}/vault-index`;
}

/** Map a vault token address to the indexer's asset key (ETH / USDC). Null = unknown token. */
export function assetSymbolForToken(tokenAddress: string, chainId?: number): string | null {
  if (tokenAddress.toLowerCase() === NATIVE_TOKEN.toLowerCase()) return "ETH";
  // Exact inverse of noteAssetAddress(): a native ETH deposit is wrapped, so its note names WETH.
  // WETH is not in getTokens(), so without this the lookup fell through to null and callers
  // substituted the raw 42-char address as the symbol — which is how a note got filed under an
  // address key and how the backup blew past `commitments.asset varchar(10)` with a 500.
  const weth = getNetwork(chainId).weth;
  if (weth && tokenAddress.toLowerCase() === weth.toLowerCase()) return "ETH";
  for (const t of Object.values(getTokens(chainId))) {
    if (t.address.toLowerCase() === tokenAddress.toLowerCase()) return t.symbol;
  }
  return null;
}

function parseLeavesPage(data: Record<string, unknown>, chainId: number, asset: string): LeavesPage | null {
  if (!Array.isArray(data.leaves)) return null;
  const leaves = data.leaves.map((l) => String(l));
  const fromIndex = Number(data.fromIndex ?? 0);
  const count = Number(data.count ?? leaves.length);
  const totalCount = Number(data.totalCount ?? leaves.length);
  const contiguous = data.contiguous !== false; // old servers omit → treat as contiguous full dump
  const nextIndex = Number(
    data.nextIndex ?? (contiguous ? fromIndex + leaves.length : fromIndex),
  );
  const tipRoot = data.tipRoot == null ? null : String(data.tipRoot);
  const tipLeafIndex =
    data.tipLeafIndex === undefined || data.tipLeafIndex === null
      ? null
      : Number(data.tipLeafIndex);
  const tipBlockNumber =
    data.tipBlockNumber === undefined || data.tipBlockNumber === null
      ? null
      : Number(data.tipBlockNumber);

  if (!Number.isFinite(fromIndex) || fromIndex < 0) return null;
  if (!Number.isFinite(totalCount) || totalCount < 0) return null;

  return {
    chainId: Number(data.chainId ?? chainId),
    asset: String(data.asset ?? asset).toUpperCase(),
    fromIndex,
    count,
    totalCount,
    nextIndex,
    tipRoot,
    tipLeafIndex: tipLeafIndex !== null && Number.isFinite(tipLeafIndex) ? tipLeafIndex : null,
    tipBlockNumber:
      tipBlockNumber !== null && Number.isFinite(tipBlockNumber) ? tipBlockNumber : null,
    contiguous,
    leaves,
  };
}

/**
 * Fetch one leaves page (incremental). fromIndex=0 returns the full indexed set when limit omitted.
 */
export async function fetchIndexedLeavesPage(
  chainId: number,
  asset: string | null,
  fromIndex = 0,
): Promise<LeavesPage | null> {
  if (!asset || !indexerAvailable()) return null;
  try {
    const url =
      `${vaultIndexBase()}/leaves?chainId=${chainId}` +
      `&asset=${encodeURIComponent(asset)}` +
      `&fromIndex=${fromIndex}`;
    // Bounded: a bare fetch() never rejects on a socket that connects and then goes silent, and
    // this call sits on the critical path of every proof (getOnChainLeaves). Without a deadline a
    // quiet indexer stalls the whole arm flow forever instead of falling through to the RPC path.
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      markIndexerDown();
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    return parseLeavesPage(data, chainId, asset);
  } catch {
    markIndexerDown();
    return null;
  }
}

/**
 * Fetch the full ORDERED merkle-leaf array for a chain + asset.
 * Prefer syncMerkleLeaves() for warm sessions; this remains for simple callers / balance set.
 */
export async function fetchIndexedLeaves(
  chainId: number,
  asset: string | null,
): Promise<bigint[] | null> {
  const page = await fetchIndexedLeavesPage(chainId, asset, 0);
  if (!page || page.leaves.length === 0) return null;
  if (!page.contiguous) return null;
  if (page.fromIndex !== 0) return null;
  return page.leaves.map((l) => BigInt(l));
}

/** Protocol-wide cumulative deposits (TVL), not a per-user balance. */
export async function fetchProtocolTvl(
  chainId: number,
): Promise<Record<string, string> | null> {
  if (!indexerAvailable()) return null;
  try {
    const res = await fetch(`${vaultIndexBase()}/balance?chainId=${chainId}`, {
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      markIndexerDown();
      return null;
    }
    const data = (await res.json()) as { balances?: Record<string, string> };
    return data.balances ?? null;
  } catch {
    markIndexerDown();
    return null;
  }
}

/**
 * Look up a vault deposit by precommitment (output-note resolution). Null on error OR
 * found:false — "not indexed yet" and "not on-chain yet" can't be told apart, so the caller
 * falls back to the RPC scan for the authoritative answer.
 */
export async function fetchIndexedDeposit(
  chainId: number,
  precommitment: string,
): Promise<{ amount: string; commitment: string; label?: string } | null> {
  if (!indexerAvailable()) return null;
  try {
    const res = await fetch(
      `${vaultIndexBase()}/deposits?chainId=${chainId}&precommitment=${encodeURIComponent(precommitment)}`,
      { headers: headers(), signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      markIndexerDown();
      return null;
    }
    const data = (await res.json()) as {
      found?: boolean;
      amount?: string;
      commitment?: string;
      label?: string;
    };
    if (!data.found || !data.amount || !data.commitment) return null;
    return {
      amount: data.amount,
      commitment: data.commitment,
      ...(data.label ? { label: data.label } : {}),
    };
  } catch {
    markIndexerDown();
    return null;
  }
}
