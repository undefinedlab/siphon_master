import { NextRequest, NextResponse } from 'next/server';
import { gateOutboundProxy } from '@/lib/outboundProxyGate';

// Coin mapping to CoinGecko IDs
const coinMap: Record<string, string> = {
  ETH: 'ethereum',
  USDC: 'usd-coin',
  SOL: 'solana',
  BTC: 'bitcoin',
  all: 'ethereum,usd-coin,solana,bitcoin',
};

type Prices = { ETH: number; USDC: number; SOL: number; BTC: number };

// Module-level cache (persists across requests on a warm serverless instance). Serving this
// for FRESH_MS avoids hammering CoinGecko's free tier into a 429 — which is what was making
// this route 500 and flooding the browser console. On any upstream failure we fall back to the
// last good cache (or a safe default) and ALWAYS return 200, so the client never logs an error.
let cache: { prices: Prices; ts: number } | null = null;
const FRESH_MS = 30_000;
const FALLBACK: Prices = { ETH: 0, USDC: 1, SOL: 0, BTC: 0 };

function ok(prices: Prices, stale: boolean) {
  return NextResponse.json(
    { prices, stale },
    { headers: { 'Cache-Control': 'public, s-maxage=60, max-age=30, stale-while-revalidate=120' } },
  );
}

export async function GET(request: NextRequest) {
  const limited = gateOutboundProxy(request, 'price', Number(process.env.PRICE_RATE_MAX || '60'));
  if (limited) return limited;

  const { searchParams } = request.nextUrl;
  const coin = searchParams.get('coin') || 'all';
  const days = searchParams.get('days');

  // Market-chart path (specific coin + days) — pass through, but never 500.
  if (coin !== 'all' && coin && days) {
    const coinId = coinMap[coin.toUpperCase()] || coinMap.all;
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`,
        { headers: cgHeaders() },
      );
      if (!res.ok) throw new Error(`coingecko ${res.status}`);
      return NextResponse.json(await res.json());
    } catch {
      return NextResponse.json({ prices: [] }, { status: 200 });
    }
  }

  // Simple-price path. Serve the cache while it's fresh.
  if (cache && Date.now() - cache.ts < FRESH_MS) return ok(cache.prices, false);

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinMap.all}&vs_currencies=usd`,
      { headers: cgHeaders() },
    );
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const data = (await res.json()) as Record<string, { usd?: number }>;
    const prices: Prices = {
      ETH: data.ethereum?.usd || cache?.prices.ETH || 0,
      USDC: data['usd-coin']?.usd || 1,
      SOL: data.solana?.usd || cache?.prices.SOL || 0,
      BTC: data.bitcoin?.usd || cache?.prices.BTC || 0,
    };
    cache = { prices, ts: Date.now() };
    return ok(prices, false);
  } catch {
    // Upstream rate-limited / down — serve last good prices (or safe fallback). Never 500.
    return ok(cache?.prices ?? FALLBACK, true);
  }
}

function cgHeaders(): Record<string, string> {
  const apiKey = process.env.COINGECKO_API_KEY;
  return {
    Accept: 'application/json',
    ...(apiKey ? { 'x-cg-demo-api-key': apiKey } : {}),
  };
}
