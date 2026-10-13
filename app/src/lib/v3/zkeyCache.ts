/**
 * Persist proving keys in Cache Storage so a withdrawal downloads them once, not every time.
 *
 * The keys are big — 45 MB for the 2-input circuits, 144 MB for the 6-input ones — and S3 already
 * serves them `public, max-age=31536000, immutable`. That header is not enough: Chromium's HTTP
 * disk cache refuses any single entry larger than a fraction of the whole cache, so a 144 MB zkey
 * is silently never stored and every proof re-downloads it. Cache Storage has no such per-entry
 * cap (it is bounded by the origin's quota), which is why the same file cached here survives.
 *
 * snarkjs takes the zkey as a URL string or as bytes. In the browser a string path fetches fine;
 * on Node (pipeline-prove / TEE) snarkjs uses `fs.open` on the string, so HTTPS S3 URLs must be
 * fetched into `Uint8Array` first — otherwise prove fails with ENOENT on the URL path.
 *
 * Every failure here falls back to the URL when a browser can still fetch it. On Node, absolute
 * URLs are always materialised as bytes when fetch succeeds.
 */

const CACHE_NAME = "siphon-zk-v1";

export type ZkeyCacheDeps = {
  caches?: CacheStorage;
  fetch?: typeof fetch;
};

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

async function fetchBytes(url: string, doFetch: typeof fetch): Promise<Uint8Array> {
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`zkey HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Bytes when they could be cached or must be materialised for Node snarkjs; otherwise the URL for
 * browser snarkjs to fetch itself (relative same-origin `/zk/...` paths).
 */
export async function loadZkey(url: string, deps: ZkeyCacheDeps = {}): Promise<Uint8Array | string> {
  const cacheStorage = deps.caches ?? (typeof caches !== "undefined" ? caches : undefined);
  const doFetch = deps.fetch ?? (typeof fetch !== "undefined" ? fetch : undefined);
  if (!doFetch) return url;

  // No Cache Storage (Node pipeline-prove): snarkjs uses fs.open on strings — must hand bytes.
  // Prefer local public/zk (our artifacts) over remote CDN/S3.
  if (!cacheStorage) {
    if (!isAbsoluteHttp(url)) {
      const rel = url.startsWith("/") ? url.slice(1) : url;
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const file = join(process.cwd(), "public", rel);
      try {
        return new Uint8Array(await readFile(file));
      } catch (e) {
        throw new Error(
          `zk artifact missing locally at ${file} (set NEXT_PUBLIC_ZK_BASE_URL only if serving remotely): ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
    return await fetchBytes(url, doFetch);
  }

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
    if (!stored) {
      // Put succeeded for the network but match missed — still hand bytes when we can re-fetch.
      if (isAbsoluteHttp(url)) return await fetchBytes(url, doFetch);
      return url;
    }
    return new Uint8Array(await stored.arrayBuffer());
  } catch {
    // Quota exceeded, private browsing, an evicted entry mid-read — none of it is worth failing a
    // withdrawal over. Prefer bytes on absolute URLs (Node + resilient browser); else URL string.
    if (isAbsoluteHttp(url)) {
      try {
        return await fetchBytes(url, doFetch);
      } catch {
        return url;
      }
    }
    return url;
  }
}
