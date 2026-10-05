import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Catch-all trade-executor reverse proxy — DISABLED.
 *
 * The browser talks to the trade-executor DIRECTLY (CORS; see tradeExecutorClient.ts).
 * This route previously forwarded arbitrary paths plus client X-API-TOKEN / wallet sigs
 * with no app-layer auth — Critical open proxy.
 *
 * /verify and /receipt remain available via next.config rewrites (receipt UX), not this API.
 */
const GONE = {
  error: 'trade_executor_proxy_disabled',
  detail:
    'Use NEXT_PUBLIC_TRADE_EXECUTOR_URL from the browser (CORS). The Next catch-all proxy is permanently disabled.',
};

async function gone() {
  return NextResponse.json(GONE, { status: 410 });
}

export const GET = gone;
export const POST = gone;
export const PUT = gone;
export const PATCH = gone;
export const DELETE = gone;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
