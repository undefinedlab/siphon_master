export const runtime = 'nodejs';
// Server-side proxy for Polymarket's public Gamma API. Kept server-side to avoid browser CORS
// and to normalize the (large, string-encoded) Gamma payload down to the fields the UI needs.
// No auth/key required — Gamma market data is public.

import { NextRequest, NextResponse } from 'next/server';
import { CDN_CACHE } from '@/lib/cdnCache';
import { gateOutboundProxy } from '@/lib/outboundProxyGate';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const MAX_GAMMA_PAGES = 2;
const MAX_MARKETS_LIMIT = 200;

/** Gamma encodes array fields as JSON strings — parse defensively. */
function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  slug: string;
  image: string;
  icon: string;
  // Parallel arrays: outcomes[i] trades at odds[i] (0..1), backed by clobTokenIds[i].
  outcomes: string[];
  odds: number[];          // 0..1 per outcome (Gamma outcomePrices)
  clobTokenIds: string[];  // the token_id per outcome — the future FHE feed key
  volume24hr: number;
  volumeTotal: number;
  liquidity: number;
  endDate: string | null;
  conditionId: string;
}

const GAMMA_PAGE = 100; // Gamma's max page size

/** Fetch up to `target` active markets by paging Gamma with offset. */
async function fetchGammaMarkets(target: number): Promise<Record<string, unknown>[]> {
  const capped = Math.min(target, MAX_MARKETS_LIMIT);
  const pages = Math.min(Math.ceil(capped / GAMMA_PAGE), MAX_GAMMA_PAGES);
  const out: Record<string, unknown>[] = [];
  for (let p = 0; p < pages; p++) {
    const gamma = new URL(`${GAMMA_BASE}/markets`);
    gamma.searchParams.set('closed', 'false');
    gamma.searchParams.set('active', 'true');
    gamma.searchParams.set('order', 'volume24hr');
    gamma.searchParams.set('ascending', 'false');
    gamma.searchParams.set('limit', String(GAMMA_PAGE));
    gamma.searchParams.set('offset', String(p * GAMMA_PAGE));
    const res = await fetch(gamma.toString(), {
      headers: { Accept: 'application/json' },
      cache: 'no-store', // raw Gamma page exceeds Next's 2MB data-cache limit; don't try to cache it
    });
    if (!res.ok) throw new Error(`Gamma ${res.status}`);
    const page = (await res.json()) as Record<string, unknown>[];
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < GAMMA_PAGE) break; // last page
  }
  return out;
}

export async function GET(req: NextRequest) {
  const limited = gateOutboundProxy(
    req,
    'polymarket-markets',
    Number(process.env.POLYMARKET_MARKETS_RATE_MAX || '20'),
  );
  if (limited) return limited;

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(parseInt(sp.get('limit') || '200', 10) || 200, MAX_MARKETS_LIMIT);
  const search = (sp.get('q') || '').trim();

  try {
    const raw = await fetchGammaMarkets(search ? MAX_MARKETS_LIMIT : limit);

    let markets: PolymarketMarket[] = (Array.isArray(raw) ? raw : [])
      .map((m): PolymarketMarket => {
        const outcomes = parseJsonArray(m.outcomes);
        const odds = parseJsonArray(m.outcomePrices).map((p) => num(p));
        return {
          id: String(m.id ?? ''),
          question: String(m.question ?? ''),
          slug: String(m.slug ?? ''),
          image: String(m.image ?? m.icon ?? ''),
          icon: String(m.icon ?? m.image ?? ''),
          outcomes,
          odds,
          clobTokenIds: parseJsonArray(m.clobTokenIds),
          volume24hr: num(m.volume24hr),
          volumeTotal: num(m.volume ?? m.volumeNum),
          liquidity: num(m.liquidity ?? m.liquidityNum),
          endDate: (m.endDate as string) ?? (m.endDateIso as string) ?? null,
          conditionId: String(m.conditionId ?? ''),
        };
      })
      // Only tradeable binary/multi markets with real odds and a CLOB token to key an FHE feed on.
      .filter((m) => m.question && m.outcomes.length >= 2 && m.clobTokenIds.length >= 2);

    if (search) {
      const q = search.toLowerCase();
      markets = markets.filter((m) => m.question.toLowerCase().includes(q)).slice(0, limit);
    }

    return NextResponse.json({ markets }, { headers: CDN_CACHE });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Gamma fetch failed' },
      { status: 502 },
    );
  }
}
