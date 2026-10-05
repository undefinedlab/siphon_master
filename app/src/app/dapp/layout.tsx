// Force the /dapp route to render dynamically (per request) instead of being prerendered as a
// static shell. The dashboard is wallet-gated and fully client-rendered, so there is nothing to
// gain from static prerendering — and it actively HURTS: Vercel edge-caches the prerendered shell
// (x-nextjs-prerender:1, stale-time 300s) and kept serving an OLD shell (referencing stale JS
// chunks) across a production deploy, so users saw pre-fix code long after the fix shipped and a
// browser cache-clear couldn't help (the stale copy lives at the CDN, not the browser).
//
// force-dynamic makes /dapp a cache MISS every time, so each load always references the CURRENT
// deployment's chunk hashes. This is a server component (no "use client") so the route segment
// config is actually honored.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function DappLayout({ children }: { children: React.ReactNode }) {
  return children;
}
