/**
 * A shared TTL cache with in-flight de-duplication, a failure backoff, and subscribers.
 *
 * Extracted from the ASP screening store because the caching is the part that has to be right and
 * the part that was wrong. Two components polled /api/asp-set/member independently every 8s; that
 * endpoint answers one label per request and allows 30 per 60s per IP, so a handful of notes put us
 * over, the limiter answered 429, and every 429 surfaced as "no data" — which the UI rendered as
 * "nothing pending", the exact inverse of the truth.
 *
 * The three properties that keep that from recurring are all here, and all testable without a
 * network: served-from-cache inside the TTL, ONE shared request for concurrent callers, and a
 * backoff that stops us hammering a window we have already filled.
 */

export type TtlCacheOptions<T> = {
  fetcher: () => Promise<T>;
  /** How long a successful read stays fresh. */
  ttlMs: number;
  /** How long to wait after a failed — or suspiciously empty — read before asking again. */
  backoffMs: number;
  /** Value served before the first successful fetch. */
  initial: T;
  /**
   * Optional: treat a successful-but-suspicious result as a failure for backoff purposes. An empty
   * screening list is indistinguishable from every lookup being rate limited, so the store passes
   * a predicate that backs off when a previously non-empty result goes empty.
   */
  suspicious?: (next: T, prev: T) => boolean;
  now?: () => number;
};

export type TtlCache<T> = {
  /** Current value. Never triggers a fetch, so it is safe during render. */
  get(): T;
  /** Fetch if stale; otherwise serve the cache. Concurrent callers share one request. */
  refresh(opts?: { force?: boolean }): Promise<T>;
  /** Mark stale so the next refresh actually fetches. */
  invalidate(): void;
  /** Subscribe to value changes; the returned function unsubscribes. */
  subscribe(listener: () => void): () => void;
  /** Wipe everything. Tests, and wallet/chain switches. */
  reset(): void;
};

export function createTtlCache<T>(opts: TtlCacheOptions<T>): TtlCache<T> {
  const now = opts.now ?? Date.now;
  let value = opts.initial;
  let fetchedAt = 0;
  let backoffUntil = 0;
  let inFlight: Promise<T> | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const l of listeners) {
      // One bad subscriber must not stop the others, or a render error silently freezes the cache.
      try { l(); } catch { /* ignore */ }
    }
  };

  return {
    get: () => value,

    refresh(o) {
      const t = now();
      if (!o?.force) {
        if (t < backoffUntil) return Promise.resolve(value);
        if (t - fetchedAt < opts.ttlMs) return Promise.resolve(value);
      }
      // The dedupe: a second caller arriving mid-flight joins the existing request rather than
      // starting another. This is what stops two components doubling the request rate.
      if (inFlight) return inFlight;

      inFlight = (async () => {
        try {
          const next = await opts.fetcher();
          if (opts.suspicious?.(next, value)) backoffUntil = now() + opts.backoffMs;
          value = next;
          fetchedAt = now();
          emit();
          return value;
        } catch {
          // Keep the last known value. Inventing a fresh empty one is how backpressure became a
          // false "nothing pending".
          backoffUntil = now() + opts.backoffMs;
          return value;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },

    invalidate() {
      fetchedAt = 0;
      backoffUntil = 0;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    reset() {
      value = opts.initial;
      fetchedAt = 0;
      backoffUntil = 0;
      inFlight = null;
    },
  };
}
