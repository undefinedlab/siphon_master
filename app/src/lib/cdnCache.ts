/**
 * Cache-Control for shared/global API responses (price, news, market data — same for every user).
 * `s-maxage` lets Vercel's CDN serve repeats from the edge; edge-cache HITs are NOT billed as
 * Function Invocations. `stale-while-revalidate` serves the stale copy while one request refreshes.
 */
export const CDN_CACHE = { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } as const;
