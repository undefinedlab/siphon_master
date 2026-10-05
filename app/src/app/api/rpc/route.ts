import { NextRequest, NextResponse } from 'next/server';
import { NETWORKS } from '@/lib/networks';
import { recordRpcRequest } from '@/lib/rpcBenchmark';
import { getCachedRpcResponse, setCachedRpcResponse } from '@/lib/rpcCache';
import { getServerRpcUrls } from '@/lib/rpcServer';
import { guardRpcProxyRequest, rpcRateLimitResponse } from '@/lib/rpcHttpGuard';

export const runtime = 'nodejs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Free-tier archive keys (Alchemy) work ~5/6 of the time and 429 on throughput bursts, not a hard
// cap. Retry the SAME upstream several times with backoff before falling through — the fallbacks
// (publicnode 403s archive, drpc rejects batches>3) are broken for this app's batched archive
// scans, so surrendering the good key early turns a transient 429 into a hard 500.
const MAX_ATTEMPTS = 5;

/**
 * A 429 that says "quota" is not the 429 the retry loop above is written for.
 *
 * A throughput burst clears in milliseconds, so retrying the good key is right. An exhausted
 * monthly plan does not clear until the billing cycle rolls over, and retrying it costs
 * 200+400+800+1600+3200 = 6.2s of backoff on EVERY request before falling through. The arming path
 * makes many eth_calls, so that is tens of seconds of dead wait; ethers gives up first and the user
 * sees "missing revert data", which points at the contract rather than at the key.
 *
 * Distinguishing them is a substring check because providers do not give a machine-readable code
 * for it — Alchemy says "Monthly capacity limit exceeded", others say "quota"/"credits".
 */
const QUOTA_EXHAUSTED =
  /monthly|capacity limit|usage limit|current plan|quota|credits?\s+exceeded|balance exceeded|billing|upgrade here/i;

/**
 * JSON-RPC error codes a provider uses to refuse service, as opposed to the chain answering.
 *
 * The distinction is the whole point: `code: 3` with `data` is an eth_call revert — the chain's
 * real answer, which must be returned verbatim. These mean the node declined to look, so returning
 * them hands the caller a non-answer dressed as an answer.
 *   -32001  1rpc "You've reached the usage limit for your current plan"  (served as HTTP 200)
 *   -32005  the de-facto "limit exceeded" across Infura/Alchemy/others
 *   -32029  rate/compute limit on several providers
 */
const PROVIDER_REFUSAL_CODES = new Set([-32001, -32005, -32029]);

type JsonRpcErr = { error?: { code?: unknown; message?: unknown } } | null;

function eachJsonRpcEntry(text: string): JsonRpcErr[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return (Array.isArray(parsed) ? parsed : [parsed]) as JsonRpcErr[];
}

/**
 * Does a 2xx body actually carry a provider refusal rather than a chain answer?
 *
 * Handles the batch shape too: ethers batches eth_calls, so the refusal arrives as an ARRAY of
 * responses and a naive `body.error` lookup misses it entirely — which is how 1rpc's quota message
 * reached the browser as "state leaves unavailable" during a withdraw.
 *
 * Deliberately does NOT treat bare `code: 429` as permanent — Alchemy serves method-throughput
 * limits that way ("Too many requests for a specific RPC call") as HTTP 200. Those must retry /
 * fall through (see isTransientRpcThrottle), not cool the key for 10 minutes.
 */
function isProviderRefusal(text: string): boolean {
  const entries = eachJsonRpcEntry(text);
  if (!entries) return false;
  return entries.some((e) => {
    const err = e?.error;
    if (!err) return false;
    if (typeof err.code === 'number' && PROVIDER_REFUSAL_CODES.has(err.code)) return true;
    return typeof err.message === 'string' && QUOTA_EXHAUSTED.test(err.message);
  });
}

/**
 * HTTP 200 + JSON-RPC throttle (Alchemy: code 429, "Too many requests for a specific RPC call").
 * Not an answer — retry with backoff, then try the next upstream. Must never be returned to the
 * browser as a successful proxy result (that is what surfaced the raw 429 during withdraw).
 */
function isTransientRpcThrottle(text: string): boolean {
  if (QUOTA_EXHAUSTED.test(text)) return false;
  const entries = eachJsonRpcEntry(text);
  if (!entries) return /too many requests/i.test(text);
  return entries.some((e) => {
    const err = e?.error;
    if (!err) return false;
    if (typeof err.code === 'number' && err.code === 429) return true;
    return typeof err.message === 'string' && /too many requests|rate.?limit|request rate exceeded/i.test(err.message);
  });
}

/**
 * Upstreams known to be out of quota, with the time to reconsider them. Module scope, so one
 * request's discovery spares every later request the same 6.2s — that is the whole point, since
 * the cost is per-call and the arming path is call-heavy.
 */
const quotaCooldown = new Map<string, number>();
const QUOTA_COOLDOWN_MS = 10 * 60_000;

function inQuotaCooldown(url: string): boolean {
  const until = quotaCooldown.get(url);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    // Expired — drop it so a reset plan (or a topped-up key) is picked up without a redeploy.
    quotaCooldown.delete(url);
    return false;
  }
  return true;
}

/** Proxy JSON-RPC to upstream nodes with fallback + 429 backoff. */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const chainId = parseInt(req.nextUrl.searchParams.get('chainId') || '', 10);
  const referer = req.headers.get('referer');
  const userAgent = req.headers.get('user-agent');
  if (!NETWORKS[chainId]) {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32600, message: 'Unsupported chainId' }, id: null },
      { status: 400 },
    );
  }

  const body = await req.text();
  // Origin, body size, batch size and method allowlist run first and always — they are free.
  // The rate limit is deferred past the cache: a cache HIT never touches an upstream node, so
  // charging it against the per-IP budget is what let the dashboard's own polling 429 itself.
  const gated = guardRpcProxyRequest(req, body, process.env, chainId, { deferRateLimit: true });
  if (!gated.ok) return gated.response;

  const cached = getCachedRpcResponse(chainId, body);
  if (cached) {
    recordRpcRequest({
      chainId,
      body,
      durationMs: Date.now() - t0,
      ok: true,
      referer,
      userAgent,
    });
    return new NextResponse(cached, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Rpc-Cache': 'HIT',
      },
    });
  }

  // Cache miss — this request will hit an upstream node, so it counts against the budget now.
  const limited = rpcRateLimitResponse(req, body, process.env, chainId);
  if (limited) return limited;

  let urls: string[];
  try {
    urls = getServerRpcUrls(chainId);
  } catch (err) {
    // A known UI chain with no EVM RPC (Solana Devnet 900002) is a bad request, not a server fault.
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32600, message: String(err) }, id: null },
      { status: 400 },
    );
  }

  let lastText = '';
  let lastStatus = 502;

  for (const upstream of urls) {
    // Skip an upstream already known to be out of quota. Without this the FIRST configured key —
    // usually the paid one, and usually first precisely because it is preferred — makes every
    // request pay the full backoff before reaching a working fallback.
    if (inQuotaCooldown(upstream)) continue;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(upstream, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        const text = await res.text();
        lastText = text;
        lastStatus = res.status;

        if (res.status === 429) {
          // Out of quota, not out of headroom: no amount of backoff fixes it, so surrender this
          // upstream now and remember it. Retrying here is what turned a dead key into
          // "missing revert data" in the browser instead of a fallback to a working node.
          if (QUOTA_EXHAUSTED.test(text)) {
            quotaCooldown.set(upstream, Date.now() + QUOTA_COOLDOWN_MS);
            break;
          }
          await sleep(200 * 2 ** attempt);
          continue;
        }

        // HTTP-level failure (e.g. 401/403 from a restricted key, 5xx) — don't surface it to
        // the client; fall through to the next upstream RPC.
        if (!res.ok) break;

        // A 2xx is NOT automatically an answer. 1rpc serves "You've reached the usage limit for
        // your current plan" as HTTP 200 with a JSON-RPC error, so the status check above waves it
        // through and the caller gets a refusal shaped like a result — it surfaced in the browser
        // as "withdrawV3: state leaves unavailable" while two working upstreams sat further down
        // this very list. An eth_call revert is still returned verbatim: that is the chain
        // answering, and isProviderRefusal only matches a provider declining to look.
        if (isProviderRefusal(text)) {
          quotaCooldown.set(upstream, Date.now() + QUOTA_COOLDOWN_MS);
          break;
        }

        // Alchemy (and others) also serve *throughput* 429s as HTTP 200 with `error.code: 429`
        // ("Too many requests for a specific RPC call"). Returning that body as success made the
        // browser fail the withdraw immediately instead of falling through to base.org / publicnode.
        if (isTransientRpcThrottle(text)) {
          await sleep(200 * 2 ** attempt);
          continue;
        }

        setCachedRpcResponse(chainId, body, text);
        recordRpcRequest({
          chainId,
          body,
          durationMs: Date.now() - t0,
          ok: true,
          referer,
          userAgent,
        });
        return new NextResponse(text, {
          status: res.status,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        lastText = JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: `RPC proxy failed: ${String(err)}` },
          id: null,
        });
        lastStatus = 502;
      }
    }
  }

  recordRpcRequest({
    chainId,
    body,
    durationMs: Date.now() - t0,
    ok: lastStatus >= 200 && lastStatus < 300,
    referer,
    userAgent,
  });
  return new NextResponse(lastText, {
    status: lastStatus,
    headers: { 'Content-Type': 'application/json' },
  });
}
