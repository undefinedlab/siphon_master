import { NextRequest, NextResponse } from 'next/server';
import { CDN_CACHE } from '@/lib/cdnCache';
import { gateOutboundProxy } from '@/lib/outboundProxyGate';

// Coin symbol -> CoinGecko ID (mirrors /api/price)
const COIN_MAP: Record<string, string> = {
  ETH: 'ethereum',
  BTC: 'bitcoin',
  SOL: 'solana',
  USDC: 'usd-coin',
};

// CoinGecko /ohlc only accepts a fixed set of `days` values.
const ALLOWED_DAYS = [1, 7, 14, 30, 90, 180, 365];

// Fresh window: don't re-hit CoinGecko more than once per minute per key.
const FRESH_MS = 60_000;
// Stale window: keep serving the last good candles for up to an hour if
// CoinGecko rate-limits us (429) or errors. Better stale candles than a 500.
const STALE_MS = 60 * 60_000;

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// Module-level cache survives across requests in the same server process.
const cache = new Map<string, { fetchedAt: number; candles: Candle[] }>();

function clampDays(raw: string | null): number {
  const n = parseInt(raw || '7', 10);
  if (Number.isNaN(n)) return 7;
  const eligible = ALLOWED_DAYS.filter((d) => d <= n);
  return eligible.length ? eligible[eligible.length - 1] : ALLOWED_DAYS[0];
}

export async function GET(request: NextRequest) {
  const limited = gateOutboundProxy(request, 'ohlc', Number(process.env.OHLC_RATE_MAX || '40'));
  if (limited) return limited;

  const { searchParams } = request.nextUrl;
  const coin = (searchParams.get('coin') || 'ETH').toUpperCase();
  const days = clampDays(searchParams.get('days'));

  const coinId = COIN_MAP[coin];
  if (!coinId) {
    return NextResponse.json({ error: `Unsupported coin: ${coin}` }, { status: 400 });
  }

  const cacheKey = `${coin}:${days}`;
  const cached = cache.get(cacheKey);
  const now = Date.now();

  // Serve fresh cache without touching CoinGecko.
  if (cached && now - cached.fetchedAt < FRESH_MS) {
    return NextResponse.json({ coin, days, candles: cached.candles, cached: true }, { headers: CDN_CACHE });
  }

  try {
    const apiKey = process.env.COINGECKO_API_KEY;
    const apiUrl = `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;

    const response = await fetch(apiUrl, {
      headers: {
        Accept: 'application/json',
        // Demo keys raise the rate limit substantially when present.
        ...(apiKey ? { 'x-cg-demo-api-key': apiKey } : {}),
      },
      next: { revalidate: 60 },
    });

    if (!response.ok) {
      console.error('[OHLC API] CoinGecko error:', response.status);
      // Rate-limited or upstream error: serve stale candles if we have any.
      if (cached && now - cached.fetchedAt < STALE_MS) {
        return NextResponse.json({ coin, days, candles: cached.candles, stale: true });
      }
      throw new Error(`Failed to fetch OHLC data: ${response.status}`);
    }

    // CoinGecko returns [[timestamp(ms), open, high, low, close], ...]
    const raw: number[][] = await response.json();
    const candles: Candle[] = raw.map(([time, open, high, low, close]) => ({
      // lightweight-charts expects time in seconds (UTCTimestamp)
      time: Math.floor(time / 1000),
      open,
      high,
      low,
      close,
    }));

    cache.set(cacheKey, { fetchedAt: now, candles });
    return NextResponse.json({ coin, days, candles }, { headers: CDN_CACHE });
  } catch (error) {
    console.error('[OHLC API] Error fetching OHLC data:', error);
    // Last resort: serve stale candles even past the stale window before 500ing.
    if (cached) {
      return NextResponse.json({ coin, days, candles: cached.candles, stale: true });
    }
    return NextResponse.json({ error: 'Failed to fetch OHLC data' }, { status: 500 });
  }
}
