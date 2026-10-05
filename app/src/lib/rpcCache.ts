/** Short-lived in-memory cache for idempotent JSON-RPC reads on /api/rpc. */

type CacheEntry = { text: string; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 500;

const TTL_MS: Record<string, number> = {
  eth_blockNumber: 3_000,
  eth_call: 20_000,
  eth_getBlockByNumber: 10_000,
};

function cacheKey(chainId: number, body: string): string {
  return `${chainId}:${body}`;
}

function parseMethod(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { method?: string };
    return typeof parsed.method === "string" ? parsed.method : null;
  } catch {
    return null;
  }
}

export function getCachedRpcResponse(
  chainId: number,
  body: string,
): string | null {
  const method = parseMethod(body);
  if (!method || !(method in TTL_MS)) return null;
  const key = cacheKey(chainId, body);
  const hit = cache.get(key);
  if (!hit || hit.expiresAt < Date.now()) {
    if (hit) cache.delete(key);
    return null;
  }
  return hit.text;
}

/**
 * Only a real answer is worth pinning. Upstreams hand back HTTP 200 for a JSON-RPC `error`, and a
 * lagging node answers a perfectly good `eth_call` with an empty `"0x"` — cache either and we serve
 * one node's bad moment to EVERY caller for the whole TTL, and any client-side retry inside that
 * window hits the poisoned entry instead of the upstream, so retrying cannot recover. That is what
 * blanked the private balance (`could not decode result data (value="0x") … merkleTree()`).
 * Declining to cache costs one extra upstream call for a void `eth_call`; the keys are shared
 * across users (ethers restarts its request `id` at 1), so caching junk costs everyone.
 */
function isCacheable(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    if (entries.length === 0) return false;
    return entries.every((e) => {
      const row = e as { error?: unknown; result?: unknown };
      return row.error === undefined && row.result !== undefined && row.result !== "0x";
    });
  } catch {
    return false;
  }
}

export function setCachedRpcResponse(
  chainId: number,
  body: string,
  text: string,
): void {
  const method = parseMethod(body);
  if (!method || !(method in TTL_MS)) return;
  if (!isCacheable(text)) return;
  if (cache.size >= MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(cacheKey(chainId, body), {
    text,
    expiresAt: Date.now() + TTL_MS[method],
  });
}
