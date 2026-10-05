/**
 * Market-resolution step for Predictions flows: turn the LLM-extracted market description
 * (parsed.polyMarketQuery) into a concrete Polymarket market via our own /api/polymarket/events
 * proxy, and pin the CLOB token id for the chosen outcome onto the parsed state.
 *
 * Runs client-side inside llmParse (same origin as the events proxy), only when the strategy is
 * Predictions and no token id has been resolved yet.
 */
import type { PolymarketEvent } from "../app/api/polymarket/events/route";
import type { ParsedPrompt } from "./types";

export interface ResolvedPolyMarket {
  marketId: string;
  tokenId: string;
  question: string;
  outcome: string;
  outcomes: string[];
  oddsPct: number;
}

const STOP_WORDS = new Set([
  "will", "the", "a", "an", "by", "in", "on", "of", "to", "for", "at", "is", "be", "and", "or",
  // generic bet-speak that matches everything and nothing
  "market", "markets", "bet", "wager", "odds", "price", "prices",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$%. ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/** Common synonyms between user phrasing and Polymarket titles. */
const TOKEN_ALIASES: Record<string, string[]> = {
  btc: ["bitcoin"],
  bitcoin: ["btc"],
  eth: ["ethereum"],
  ethereum: ["eth"],
  sol: ["solana"],
  solana: ["sol"],
};

/** "150k" also matches "150,000" / "150000", "48000" matches "48,000"; "$150k" matches "150k". */
function tokenVariants(token: string): string[] {
  const variants = [token, ...(TOKEN_ALIASES[token] ?? [])];
  const kMatch = token.match(/^\$?(\d+(?:\.\d+)?)k$/);
  if (kMatch) {
    const thousands = Math.round(parseFloat(kMatch[1]) * 1000);
    variants.push(String(thousands), thousands.toLocaleString("en-US"), `${kMatch[1]}k`);
  }
  const plainNum = token.match(/^\$?(\d{4,})$/);
  if (plainNum) {
    variants.push(Number(plainNum[1]).toLocaleString("en-US"));
  }
  return variants;
}

/** Number of query tokens (or their variants) present in the candidate text. */
function countHits(queryTokens: string[], candidateText: string): number {
  const hay = candidateText.toLowerCase();
  return queryTokens.filter((t) => tokenVariants(t).some((v) => hay.includes(v))).length;
}

function pickOutcomeIndex(outcomes: string[], wanted: string | null): number {
  if (!wanted) return 0;
  const w = wanted.trim().toLowerCase();
  const exact = outcomes.findIndex((o) => o.toLowerCase() === w);
  if (exact >= 0) return exact;
  const partial = outcomes.findIndex(
    (o) => o.toLowerCase().includes(w) || w.includes(o.toLowerCase()),
  );
  return partial >= 0 ? partial : 0;
}

async function fetchEventsForQuery(q: string): Promise<PolymarketEvent[]> {
  try {
    const res = await fetch(`/api/polymarket/events?q=${encodeURIComponent(q)}&limit=40`);
    if (!res.ok) return [];
    const data = (await res.json()) as { events?: PolymarketEvent[] };
    return data.events ?? [];
  } catch {
    return [];
  }
}

/**
 * The events proxy's `q` is a full-substring filter on event title / market label, so a natural
 * phrase ("Will BTC hit 150k by March") usually matches nothing. Fan out: the full query plus the
 * most distinctive keywords, in parallel, then union the candidate pools and score locally.
 */
async function fetchCandidateEvents(query: string): Promise<PolymarketEvent[]> {
  const tokens = tokenize(query);
  // Expand aliases at fetch time too — Gamma titles say "Bitcoin", users say "BTC".
  const keywords = [...tokens]
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .flatMap((k) => [k, ...(TOKEN_ALIASES[k] ?? [])]);
  const attempts = [...new Set([query, ...keywords])].slice(0, 5);

  const pools = await Promise.all(attempts.map(fetchEventsForQuery));

  const seen = new Set<string>();
  const events: PolymarketEvent[] = [];
  for (const pool of pools) {
    for (const ev of pool) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      events.push(ev);
    }
  }
  return events;
}

/** Search Polymarket (via our events proxy) and return the best-matching market, or null. */
export async function resolvePolymarketMarket(
  query: string,
  outcome: string | null,
): Promise<ResolvedPolyMarket | null> {
  const events = await fetchCandidateEvents(query);
  const queryTokens = tokenize(query);
  let best: { market: PolymarketEvent["markets"][number]; score: number; volume: number } | null =
    null;

  for (const ev of events) {
    for (const m of ev.markets) {
      if (!m.clobTokenIds || m.clobTokenIds.length < 2) continue;
      const score = countHits(queryTokens, `${ev.title} ${m.question} ${m.label}`);
      const volume = m.volume24hr || 0;
      if (
        !best ||
        score > best.score ||
        (score === best.score && volume > best.volume)
      ) {
        best = { market: m, score, volume };
      }
    }
  }

  // A single generic-token hit isn't a match — require at least two query tokens to land
  // (or all of them for one/two-word queries), else we'd bet on an arbitrary market.
  const minHits = Math.min(2, queryTokens.length);
  if (!best || best.score < minHits || minHits === 0) return null;

  const m = best.market;
  const idx = pickOutcomeIndex(m.outcomes ?? [], outcome);
  const tokenId = m.clobTokenIds[idx];
  if (!tokenId) return null;

  return {
    marketId: String(m.id),
    tokenId: String(tokenId),
    question: m.question,
    outcome: m.outcomes[idx],
    outcomes: m.outcomes,
    oddsPct: Math.round((m.odds?.[idx] ?? 0) * 100),
  };
}

/**
 * Resolution + structural defaults for a Predictions parse. Returns the (possibly) updated parsed
 * state and a user-facing note describing the matched market (or the miss).
 */
export async function applyPredictionsResolution(
  parsed: ParsedPrompt,
): Promise<{ parsed: ParsedPrompt; note: string | null }> {
  if (parsed.strategy !== "Predictions") return { parsed, note: null };

  // Predictions flows are Deposit(USDC) → Predictions; the bridge/order/shield-back rails live in
  // the executor, not on the canvas.
  let next: ParsedPrompt = {
    ...parsed,
    coin: "USDC",
    side: "buy",
    useLoop: false,
    includeSwap: false,
    toCoin: null,
  };

  if (!next.polyMarketQuery || next.polyTokenId) {
    return { parsed: next, note: null };
  }

  const resolved = await resolvePolymarketMarket(next.polyMarketQuery, next.polyOutcome);
  if (!resolved) {
    return {
      parsed: next,
      note: `I couldn't find a Polymarket market matching “${next.polyMarketQuery}”. Try rephrasing it closer to the market's title.`,
    };
  }

  next = {
    ...next,
    polyTokenId: resolved.tokenId,
    polyMarketId: resolved.marketId,
    polyMarketQuestion: resolved.question,
    polyOutcome: resolved.outcome,
    polyOdds: String(resolved.oddsPct),
    polyOutcomes: resolved.outcomes,
  };

  return {
    parsed: next,
    note: `Matched Polymarket market: “${resolved.question}” — ${resolved.outcome} currently at ${resolved.oddsPct}%.`,
  };
}
