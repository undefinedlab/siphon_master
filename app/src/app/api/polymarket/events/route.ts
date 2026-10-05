export const runtime = 'nodejs';
// Server-side proxy for Polymarket's public Gamma /events API. An "event" groups related markets
// (e.g. "World Cup Winner" contains one market per country). We normalize events + their member
// markets and map each event's messy tag list down to one broad category for the UI's chips.

import { NextRequest, NextResponse } from 'next/server';
import type { PolymarketMarket } from '../markets/route';
import { gateOutboundProxy } from '@/lib/outboundProxyGate';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const GAMMA_PAGE = 100;
/** Cap upstream amplification — at most 2 Gamma pages (~200 events) per request (OVERLORD F-12). */
const MAX_GAMMA_PAGES = 2;
const MAX_EVENTS_LIMIT = 200;

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

// Broad category ← raw tag keywords (first match wins, in this priority order).
const CATEGORY_RULES: { category: string; keywords: string[] }[] = [
  { category: 'Politics', keywords: ['politic', 'election', 'president', 'congress', 'senate', 'trump', 'government', 'geopolit', 'war', 'israel', 'ukraine', 'nato'] },
  { category: 'Crypto', keywords: ['crypto', 'bitcoin', 'ethereum', 'altcoin', 'solana', 'stablecoin', 'defi'] },
  { category: 'Economy', keywords: ['fed', 'economy', 'inflation', 'rates', 'interest', 'recession', 'gdp', 'jobs', 'cpi'] },
  { category: 'Sports', keywords: ['sport', 'soccer', 'football', 'nba', 'nfl', 'mlb', 'nhl', 'tennis', 'cricket', 'fifa', 'world cup', 'esports', 'ufc', 'golf', 'f1'] },
  { category: 'Culture', keywords: ['pop culture', 'movie', 'music', 'award', 'celebrity', 'tv', 'oscar', 'entertainment'] },
];

function categoryFromTags(tags: string[]): string {
  const hay = tags.join(' ').toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((k) => hay.includes(k))) return rule.category;
  }
  return 'Other';
}

function normalizeMarket(m: Record<string, unknown>): PolymarketMarket & { label: string } {
  const outcomes = parseJsonArray(m.outcomes);
  return {
    id: String(m.id ?? ''),
    question: String(m.question ?? ''),
    label: String(m.groupItemTitle || m.question || ''),
    slug: String(m.slug ?? ''),
    image: String(m.image ?? m.icon ?? ''),
    icon: String(m.icon ?? m.image ?? ''),
    outcomes,
    odds: parseJsonArray(m.outcomePrices).map(num),
    clobTokenIds: parseJsonArray(m.clobTokenIds),
    volume24hr: num(m.volume24hr),
    volumeTotal: num(m.volume ?? m.volumeNum),
    liquidity: num(m.liquidity ?? m.liquidityNum),
    endDate: (m.endDate as string) ?? (m.endDateIso as string) ?? null,
    conditionId: String(m.conditionId ?? ''),
  };
}

export interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  image: string;
  category: string;
  tags: string[];
  volume24hr: number;
  volumeTotal: number;
  endDate: string | null;
  markets: (PolymarketMarket & { label: string })[];
}

async function fetchEvents(target: number): Promise<Record<string, unknown>[]> {
  const capped = Math.min(target, MAX_EVENTS_LIMIT);
  const pages = Math.min(Math.ceil(capped / GAMMA_PAGE), MAX_GAMMA_PAGES);
  const out: Record<string, unknown>[] = [];
  for (let p = 0; p < pages; p++) {
    const url = new URL(`${GAMMA_BASE}/events`);
    url.searchParams.set('closed', 'false');
    url.searchParams.set('active', 'true');
    url.searchParams.set('order', 'volume24hr');
    url.searchParams.set('ascending', 'false');
    url.searchParams.set('limit', String(GAMMA_PAGE));
    url.searchParams.set('offset', String(p * GAMMA_PAGE));
    // no-store: the raw Gamma event payload is ~16MB — over Next's 2MB data-cache limit, so caching
    // it fails noisily every request. We cache the SMALL normalized result at the module level below.
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`Gamma ${res.status}`);
    const page = (await res.json()) as Record<string, unknown>[];
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < GAMMA_PAGE) break;
  }
  return out;
}

// Module-level TTL cache of the NORMALIZED (small) result, keyed by limit. Avoids re-fetching +
// re-normalizing Gamma's multi-MB payload on every page load / poll.
type EventsResult = { events: PolymarketEvent[]; categories: Record<string, number> };
const _cache = new Map<string, { data: EventsResult; ts: number }>();
const CACHE_TTL_MS = 60_000;

export async function GET(req: NextRequest) {
  const limited = gateOutboundProxy(
    req,
    'polymarket-events',
    Number(process.env.POLYMARKET_EVENTS_RATE_MAX || '20'),
  );
  if (limited) return limited;

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(parseInt(sp.get('limit') || '120', 10) || 120, MAX_EVENTS_LIMIT);
  const search = (sp.get('q') || '').trim().toLowerCase();
  const bust = sp.has('_t');

  // Serve the cached normalized result for plain (non-search) loads within the TTL.
  const cacheKey = `l${limit}`;
  if (!search && !bust) {
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      return NextResponse.json(hit.data);
    }
  }

  try {
    const raw = await fetchEvents(search ? MAX_EVENTS_LIMIT : limit);

    let events: PolymarketEvent[] = (Array.isArray(raw) ? raw : [])
      .map((e): PolymarketEvent => {
        const tags = (Array.isArray(e.tags) ? e.tags : [])
          .map((t) => String((t as Record<string, unknown>)?.label ?? ''))
          .filter(Boolean);
        const markets = (Array.isArray(e.markets) ? e.markets : [])
          .map((m) => normalizeMarket(m as Record<string, unknown>))
          .filter((m) => m.outcomes.length >= 2 && m.clobTokenIds.length >= 2);
        return {
          id: String(e.id ?? ''),
          title: String(e.title ?? ''),
          slug: String(e.slug ?? ''),
          image: String(e.image ?? e.icon ?? ''),
          category: categoryFromTags(tags),
          tags,
          volume24hr: num(e.volume24hr),
          volumeTotal: num(e.volume),
          endDate: (e.endDate as string) ?? null,
          markets,
        };
      })
      .filter((e) => e.title && e.markets.length > 0);

    if (search) {
      events = events
        .filter(
          (e) =>
            e.title.toLowerCase().includes(search) ||
            e.markets.some((m) => m.label.toLowerCase().includes(search)),
        )
        .slice(0, limit);
    }

    // Category counts for the chips.
    const categories: Record<string, number> = {};
    for (const e of events) categories[e.category] = (categories[e.category] ?? 0) + 1;

    const result: EventsResult = { events, categories };
    if (!search) _cache.set(cacheKey, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Gamma fetch failed' },
      { status: 502 },
    );
  }
}
