/**
 * Persist proving keys in Cache Storage so a withdrawal downloads them once, not every time.
 *
 * The keys are big — 45 MB for the 2-input circuits, 144 MB for the 6-input ones — and S3 already
 * serves them `public, max-age=31536000, immutable`. That header is not enough: Chromium's HTTP
 * disk cache refuses any single entry larger than a fraction of the whole cache, so a 144 MB zkey
 * is silently never stored and every proof re-downloads it. Cache Storage has no such per-entry
 * cap (it is bounded by the origin's quota), which is why the same file cached here survives.
 *
 * snarkjs takes the zkey as a URL string or as bytes, and in the browser the string path fetches
 * the whole file into memory anyway — so handing it bytes loses no streaming, it only skips the
 * download. Every failure here falls back to the URL: a cache is an optimisation, and none of this
 * may ever be the reason a user cannot withdraw.
 */

const CACHE_NAME = "siphon-zk-v1";

export type ZkeyCacheDeps = {
  caches?: CacheStorage;
  fetch?: typeof fetch;
};

/** Bytes when they could be cached or fetched, otherwise the URL for snarkjs to fetch itself. */
export async function loadZkey(url: string, deps: ZkeyCacheDeps = {}): Promise<Uint8Array | string> {
  const cacheStorage = deps.caches ?? (typeof caches !== "undefined" ? caches : undefined);
  const doFetch = deps.fetch ?? (typeof fetch !== "undefined" ? fetch : undefined);
  if (!cacheStorage || !doFetch) return url;

  try {
    const cache = await cacheStorage.open(CACHE_NAME);

    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());

    const res = await doFetch(url);
    if (!res.ok) throw new Error(`zkey HTTP ${res.status}`);

    // Store first, then read back out of the cache. Cloning instead would hold the whole key twice
    // in memory, and at 144 MB that is its own failure mode on a modest laptop.
    await cache.put(url, res);
    const stored = await cache.match(url);
    if (!stored) return url;
    return new Uint8Array(await stored.arrayBuffer());
  } catch {
    // Quota exceeded, private browsing, an evicted entry mid-read — none of it is worth failing a
    // withdrawal over. snarkjs fetches the URL exactly as it did before this module existed.
    return url;
  }
}
