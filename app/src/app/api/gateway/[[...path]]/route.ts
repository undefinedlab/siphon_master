import { NextRequest, NextResponse } from 'next/server';
import { API_KEYS_COMING_SOON } from '@/lib/apiKeysFlag';
import { assertBrowserSameOrigin } from '@/lib/apiWalletAuth';
import { clientKeyFromRequest, isRateLimited } from '@/lib/graphHttpGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Browser → api-gateway proxy for the dashboard's API Keys panel.
 *
 * This route was disabled outright in 08ae6c0 ("OMEGA auth hardening"). It deserved it: it was a
 * catch-all that forwarded ANY path plus the caller's `Authorization` header to an internal
 * service, which is both an SSRF-shaped hole and a way to reach gateway admin routes from a
 * browser. Re-opening it therefore changes three things and keeps the fourth:
 *
 *   1. Paths are an exact allowlist, not a catch-all. `[[...path]]` still matches everything, so
 *      the allowlist — not the route file's shape — is what limits reach.
 *   2. `authorization` is NEVER forwarded. It was the actual privilege-escalation vector: the
 *      gateway treats a bearer token as a first-class API credential, so passing one through let
 *      a browser caller speak as any key it could guess or steal.
 *   3. Same-origin + rate limit, so this is not an open relay to the gateway for the internet.
 *   4. Auth itself stays UPSTREAM. The gateway verifies `Siphon API v1:<chainId>:<ts>` signed by
 *      the wallet (see lib/apiKeys.ts). Verifying it a second time here would mean either
 *      duplicating that scheme or making the user sign twice — two MetaMask popups to list their
 *      own keys. The wallet headers are forwarded verbatim and the gateway remains the authority.
 *
 * The SDK and MCP talk to the gateway origin directly and do not use this route at all; it exists
 * only so the browser never has to hold API_GATEWAY_URL or a token.
 */

/** Exact upstream paths the dashboard needs, with the methods each accepts. */
const ALLOWED: Record<string, ReadonlySet<string>> = {
  'v1/keys': new Set(['GET']),
  'v1/keys/packs': new Set(['GET']),
  'v1/keys/purchase': new Set(['POST']),
  // Free Solana Devnet key, signed by the Solana wallet (gateway verify_wallet_intent).
  'v1/keys/devnet': new Set(['POST']),
};

/**
 * Headers passed upstream. `authorization` is deliberately absent — see (2) above. The wallet
 * triple is what the gateway authenticates with; `idempotency-key` makes a retried purchase safe
 * to replay, so dropping it would risk double-charging a wallet whose first response was lost.
 */
const FORWARD = [
  'content-type',
  'accept',
  'x-wallet-address',
  'x-signature',
  'x-timestamp',
  // Session-key delegation. This proxy forwards an explicit allowlist, so a header missing here is
  // simply dropped — the gateway then sees a signature from an address that is not the claimed
  // wallet and 401s, with nothing on either side explaining why.
  'x-session-delegation',
  'x-session-key',
  'idempotency-key',
  // Fund-moving routes are behind verify_wallet_intent, whose message binds a single-use nonce and
  // whose response is sealed under a one-time delivery key. Both travel as headers, so dropping
  // either here turns every purchase into a 401 or a BadRequest at the gateway.
  'x-nonce',
  'x-delivery-key',
] as const;

/** Railway siphon-sol-devnet api-gateway (not the legacy api.siphon.money box). */
const DEFAULT_API_GATEWAY_URL = 'https://api-gateway-production-41e4.up.railway.app';

function upstreamBase(): string {
  return (
    process.env.API_GATEWAY_URL ||
    process.env.NEXT_PUBLIC_API_GATEWAY_URL ||
    DEFAULT_API_GATEWAY_URL
  ).replace(/\/+$/, '');
}

/** Free Solana Devnet claim stays reachable while paid key purchase is still locked. */
const DEVNET_KEY_PATH = 'v1/keys/devnet';

async function proxy(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const originDeny = assertBrowserSameOrigin(req);
  if (originDeny) return NextResponse.json(originDeny.body, { status: originDeny.status });

  const { path } = await ctx.params;
  const subpath = (path || []).join('/');
  const methods = ALLOWED[subpath];
  const method = (req.method || 'GET').toUpperCase();
  // One 404 for both unknown and not-allowed: enumerating which paths exist is free recon.
  if (!methods || !methods.has(method)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Paid key surface locked → 503. Free Devnet claim is the exception (dashboard + MCP).
  if (API_KEYS_COMING_SOON && subpath !== DEVNET_KEY_PATH) {
    return NextResponse.json(
      { error: 'not_yet_available', detail: 'The Siphon API is not open yet.' },
      { status: 503 },
    );
  }

  const base = upstreamBase();

  const ip = clientKeyFromRequest(req);
  const max = Number(process.env.API_GATEWAY_RATE_MAX || '30');
  if (isRateLimited(`api-gateway:${ip}`, max)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const headers: Record<string, string> = {};
  for (const h of FORWARD) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }

  const body = method === 'GET' || method === 'HEAD' ? undefined : await req.text();

  try {
    const upstream = await fetch(`${base}/${subpath}${req.nextUrl.search}`, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'api_gateway_unreachable', message: String(err) },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
