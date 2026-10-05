import { NextRequest, NextResponse } from 'next/server';
import { CDN_CACHE } from '@/lib/cdnCache';
import { gateOutboundProxy } from '@/lib/outboundProxyGate';

// Pyth Network price feed IDs (Hermes format)
// These are the price feed IDs for USD pairs
// Format: price feed ID without 0x prefix (as required by Hermes API)
// 
// To find price feed IDs:
// 1. Visit https://pyth.network/developers/price-feed-ids
// 2. Or use the Hermes API: https://hermes.pyth.network/api/latest_price_feeds
// 3. Price feed IDs are hex strings (64 characters)
//
// Current mappings (verify these are correct):
const PYTH_PRICE_FEED_IDS: Record<string, string> = {
  'ETH': 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', // Crypto.ETH/USD
  'BTC': 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', // Crypto.BTC/USD
  'SOL': 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', // Crypto.SOL/USD
  'USDC': '1.0', // USDC/USD is always 1.0 (stablecoin)
};

// Hermes API base URL
const HERMES_API_BASE = 'https://hermes.pyth.network/api';

interface PythPriceFeed {
  id: string;
  price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
  ema_price?: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
}

/**
 * Convert Pyth price to actual USD value
 * Pyth prices are stored as integers with an exponent
 * actualPrice = price * 10^expo
 */
function convertPythPrice(price: string, expo: number): number {
  const priceNum = parseFloat(price);
  return priceNum * Math.pow(10, expo);
}

/**
 * Fetch price feed from Pyth Hermes API
 */
async function fetchPythPriceFeed(priceId: string): Promise<PythPriceFeed | null> {
  try {
    // Ensure ID doesn't have 0x prefix for Hermes API
    const cleanId = priceId.startsWith('0x') ? priceId.slice(2) : priceId;
    
    // Hermes API expects IDs in array format
    const url = `${HERMES_API_BASE}/latest_price_feeds?ids[]=${cleanId}`;
    console.log('[Pyth API] Fetching price feed:', url);
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
      },
      // Add cache control to get fresh data
      cache: 'no-store',
      next: { revalidate: 0 }, // Always fetch fresh data
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Pyth API] Error response:', response.status, errorText);
      
      // Handle rate limiting
      if (response.status === 429) {
        console.warn('[Pyth API] Rate limit exceeded, waiting...');
      }
      
      return null;
    }
    
    const data: PythPriceFeed[] = await response.json();
    
    if (data && data.length > 0 && data[0]) {
      console.log('[Pyth API] Received price feed:', {
        id: data[0].id,
        price: data[0].price.price,
        expo: data[0].price.expo,
        conf: data[0].price.conf
      });
      return data[0];
    }
    
    console.warn('[Pyth API] Empty response from Hermes');
    return null;
  } catch (error) {
    console.error('[Pyth API] Error fetching price feed:', error);
    return null;
  }
}

/**
 * Independent spot sources, used only when Pyth is unavailable.
 *
 * Pyth's public Hermes started answering 401 `unauthorized` on BOTH the v1
 * (/api/latest_price_feeds) and v2 (/v2/updates/price/latest) endpoints — verified from two
 * different networks, so it is an upstream access change, not a local block. With no fallback the
 * route returned only the hardcoded USDC=1.0 and every ETH-denominated flow stalled on
 * "Live ETH/USD price unavailable".
 *
 * A MEDIAN of whatever responds, not first-wins: this price sets the arming fee AND feeds
 * estimateMinOutWei, which is the only slippage bound on a vault-output leg. One source being
 * wrong, stale, or manipulated would move a real bound, so a single fallback would trade an
 * outage for a worse failure. Two sources agreeing is the minimum; one alone is returned only
 * because refusing to price at all is itself a failure, and the caller still sanity-checks it.
 */
const SPOT_SOURCES: Record<string, { url: string; pick: (j: unknown) => number | null }[]> = {
  ETH: [
    {
      url: 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT',
      pick: (j) => Number((j as { price?: string })?.price) || null,
    },
    {
      url: 'https://api.coinbase.com/v2/prices/ETH-USD/spot',
      pick: (j) => Number((j as { data?: { amount?: string } })?.data?.amount) || null,
    },
    {
      url: 'https://api.kraken.com/0/public/Ticker?pair=ETHUSD',
      pick: (j) => {
        const r = (j as { result?: Record<string, { c?: string[] }> })?.result;
        const first = r && Object.values(r)[0];
        return Number(first?.c?.[0]) || null;
      },
    },
  ],
  BTC: [
    {
      url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
      pick: (j) => Number((j as { price?: string })?.price) || null,
    },
    {
      url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
      pick: (j) => Number((j as { data?: { amount?: string } })?.data?.amount) || null,
    },
  ],
  SOL: [
    {
      url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
      pick: (j) => Number((j as { price?: string })?.price) || null,
    },
    {
      url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot',
      pick: (j) => Number((j as { data?: { amount?: string } })?.data?.amount) || null,
    },
  ],
};

function median(xs: number[]): number | null {
  const v = xs.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

async function fetchSpotFallback(symbol: string): Promise<number | null> {
  const sources = SPOT_SOURCES[symbol];
  if (!sources) return null;

  const results = await Promise.all(
    sources.map(async (src) => {
      try {
        const res = await fetch(src.url, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) return null;
        return src.pick(await res.json());
      } catch {
        return null;
      }
    }),
  );

  const ok = results.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
  if (ok.length === 0) return null;

  // Disagreement beyond 5% means at least one source is bad; the median still picks a sane
  // value, but say so, because this price ends up in a slippage bound.
  const m = median(ok);
  if (m !== null && ok.length > 1) {
    const spread = (Math.max(...ok) - Math.min(...ok)) / m;
    if (spread > 0.05) {
      console.warn(`[Pyth API] fallback sources disagree for ${symbol} by ${(spread * 100).toFixed(1)}%:`, ok);
    }
  }
  console.warn(`[Pyth API] Pyth unavailable — ${symbol} priced from ${ok.length} fallback source(s): ${m}`);
  return m;
}

export async function GET(request: NextRequest) {
  const limited = gateOutboundProxy(request, 'pyth_price', Number(process.env.PYTH_PRICE_RATE_MAX || '60'));
  if (limited) return limited;

  try {
    const { searchParams } = new URL(request.url);
    const coin = searchParams.get('coin') || 'all';
    const coinUpper = coin.toUpperCase();
    
    console.log('[Pyth API] Request for coin:', coinUpper);
    
    // Handle USDC separately (always 1.0)
    if (coinUpper === 'USDC') {
      return NextResponse.json({
        prices: {
          USDC: 1.0
        },
        source: 'pyth',
        timestamp: Date.now()
      });
    }
    
    // Handle 'all' or fetch specific coin
    const coinsToFetch = coinUpper === 'ALL' 
      ? ['ETH', 'BTC', 'SOL', 'USDC']
      : [coinUpper];
    
    const prices: Record<string, number> = {};
    const errors: Record<string, string> = {};
    let usedFallback = false;
    
    // Fetch prices for each coin
    for (const coinSymbol of coinsToFetch) {
      if (coinSymbol === 'USDC') {
        prices[coinSymbol] = 1.0;
        continue;
      }
      
      const priceId = PYTH_PRICE_FEED_IDS[coinSymbol];
      
      if (!priceId) {
        console.warn(`[Pyth API] No price feed ID found for: ${coinSymbol}`);
        errors[coinSymbol] = 'Price feed ID not found';
        continue;
      }
      
      if (priceId === '1.0') {
        prices[coinSymbol] = 1.0;
        continue;
      }
      
      const priceFeed = await fetchPythPriceFeed(priceId);
      
      if (priceFeed && priceFeed.price) {
        const actualPrice = convertPythPrice(priceFeed.price.price, priceFeed.price.expo);
        prices[coinSymbol] = actualPrice;
        
        console.log(`[Pyth API] ✓ ${coinSymbol} price:`, {
          price: actualPrice,
          confidence: convertPythPrice(priceFeed.price.conf, priceFeed.price.expo),
          publishTime: new Date(priceFeed.price.publish_time * 1000).toISOString(),
          rawPrice: priceFeed.price.price,
          expo: priceFeed.price.expo
        });
      } else {
        // Pyth is down or gated — fall back to independent spot sources rather than returning a
        // price set with a hole in it, which reads downstream as "price missing or zero".
        const spot = await fetchSpotFallback(coinSymbol);
        if (spot !== null) {
          prices[coinSymbol] = spot;
          usedFallback = true;
        } else {
          console.error(`[Pyth API] ✗ Failed to fetch price for ${coinSymbol}`);
          errors[coinSymbol] = 'Failed to fetch price feed';
        }
      }
    }
    
    // If fetching all coins, ensure USDC is included
    if (coinUpper === 'ALL') {
      prices['USDC'] = 1.0;
    }
    
    // Return response
    const response: { prices: Record<string, number>; source: string; timestamp: number; errors?: Record<string, string> } = {
      prices,
      // Report the source honestly. Callers that treat this price as oracle-grade need to know
      // when it came from exchange spot instead, and "pyth" on a fallback price would hide it.
      source: usedFallback ? 'spot-fallback' : 'pyth',
      timestamp: Date.now()
    };
    
    if (Object.keys(errors).length > 0) {
      response.errors = errors;
    }
    
    // Verify we got at least one price
    if (Object.keys(prices).length === 0) {
      return NextResponse.json(
        { 
          error: 'Failed to fetch any prices',
          errors 
        },
        { status: 500 }
      );
    }
    
    return NextResponse.json(response, { headers: CDN_CACHE });

  } catch (error) {
    console.error('[Pyth API] Error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch price data',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

