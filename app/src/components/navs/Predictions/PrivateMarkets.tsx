"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import type { PolymarketMarket } from "@/app/api/polymarket/markets/route";
import type { PolymarketEvent } from "@/app/api/polymarket/events/route";
import PrivateTradeModal from "./PrivateTradeModal";
import PrivatePositions from "./PrivatePositions";
import "./PrivateMarkets.css";

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/** Groups start expanded when small; big ones (e.g. World Cup's 60) collapse to avoid a wall. */
const AUTO_EXPAND_MAX = 8;
const CATEGORY_ORDER = ["Sports", "Politics", "Crypto", "Economy", "Culture", "Other"];

export default function PrivateMarkets() {
  const [events, setEvents] = useState<PolymarketEvent[]>([]);
  const [categories, setCategories] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeCat, setActiveCat] = useState<string>("All");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<PolymarketMarket | null>(null);
  const didInitExpand = useRef(false);

  const load = useCallback(async (q: string, bust = false) => {
    setLoading(true);
    setError(null);
    try {
      const url =
        `/api/polymarket/events?limit=150` +
        (q ? `&q=${encodeURIComponent(q)}` : "") +
        (bust ? `&_t=${Date.now()}` : "");
      const res = await fetch(url, bust ? { cache: "no-store" } : undefined);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const evs: PolymarketEvent[] = data.events ?? [];
      setEvents(evs);
      setCategories(data.categories ?? {});
      // Auto-expand small groups on first load only — background refreshes must not stomp
      // the user's expand/collapse state.
      if (!didInitExpand.current) {
        didInitExpand.current = true;
        setExpanded(new Set(evs.filter((e) => e.markets.length <= AUTO_EXPAND_MAX).map((e) => e.id)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load markets");
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);
  useEffect(() => {
    const t = setTimeout(() => void load(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query, load]);
  // Live odds: re-pull every 60s (matches the server route's cache TTL, so this is one
  // upstream Gamma fetch per minute regardless of how many tabs are open).
  useEffect(() => {
    const iv = setInterval(() => void load(query.trim()), 60_000);
    return () => clearInterval(iv);
  }, [query, load]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const visible = useMemo(
    () => (activeCat === "All" ? events : events.filter((e) => e.category === activeCat)),
    [events, activeCat],
  );

  const chips = useMemo(() => {
    const total = events.length;
    const cats = CATEGORY_ORDER.filter((c) => (categories[c] ?? 0) > 0);
    return [{ name: "All", count: total }, ...cats.map((c) => ({ name: c, count: categories[c] }))];
  }, [events, categories]);

  return (
    <div className="pmkt-view">
      <div className="pmkt-wrap">
        <header className="pmkt-header">
          <div className="pmkt-badge">POWERED BY POLYMARKET · PRIVATE</div>
          <h1 className="pmkt-title">Private Markets</h1>
          <p className="pmkt-sub">
            Trade any Polymarket market through Siphon — shielded funding, an encrypted trigger, and
            winnings that return to your private vault. <span className="pmkt-sub-em">Public trade,
            private trader.</span>
          </p>

          <div className="pmkt-privacy-row">
            <span className="pmkt-chip pmkt-chip--on">🔒 Funder hidden (ZK)</span>
            <span className="pmkt-chip pmkt-chip--on">🔒 Thesis hidden (FHE)</span>
            <span className="pmkt-chip pmkt-chip--on">🔒 Winnings shielded</span>
            <span className="pmkt-chip pmkt-chip--off">Order on book: public</span>
          </div>

          <div className="pmkt-searchbar">
            <input
              className="pmkt-search"
              placeholder="Search markets & groups…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              className={`pmkt-refresh${loading ? " pmkt-refresh--spin" : ""}`}
              onClick={() => void load(query.trim(), true)}
              disabled={loading}
              aria-label="Refresh markets"
              title="Refresh markets"
            >
              ↻
            </button>
          </div>

          {/* Category chips */}
          <div className="pmkt-cats">
            {chips.map((c) => (
              <button
                key={c.name}
                className={`pmkt-cat${activeCat === c.name ? " pmkt-cat--on" : ""}`}
                onClick={() => setActiveCat(c.name)}
              >
                {c.name} <span className="pmkt-cat-count">{c.count}</span>
              </button>
            ))}
          </div>
        </header>

        <PrivatePositions />

        {loading && events.length === 0 ? (
          <div className="pmkt-state">Loading live markets…</div>
        ) : error ? (
          <div className="pmkt-state pmkt-state--err">Couldn’t load markets: {error}</div>
        ) : visible.length === 0 ? (
          <div className="pmkt-state">No markets found{query ? ` for “${query}”` : ""}.</div>
        ) : (
          <div className="pmkt-groups">
            {visible.map((ev) => {
              const open = expanded.has(ev.id);
              return (
                <section key={ev.id} className="pmkt-group">
                  <button className="pmkt-group-head" onClick={() => toggle(ev.id)}>
                    {ev.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="pmkt-group-img" src={ev.image} alt="" loading="lazy" />
                    ) : (
                      <div className="pmkt-group-img pmkt-group-img--ph" />
                    )}
                    <div className="pmkt-group-titles">
                      <span className="pmkt-group-title">{ev.title}</span>
                      <span className="pmkt-group-meta">
                        <span className="pmkt-group-cat">{ev.category}</span>
                        {" · "}{ev.markets.length} market{ev.markets.length !== 1 ? "s" : ""}
                        {" · "}Vol 24h {fmtUsd(ev.volume24hr)}
                      </span>
                    </div>
                    <span className={`pmkt-group-chev${open ? " pmkt-group-chev--open" : ""}`}>▸</span>
                  </button>

                  {open && (
                    <div className="pmkt-group-grid">
                      {ev.markets.map((m) => {
                        const pct = Math.round((m.odds?.[0] ?? 0) * 100);
                        const outcomes = m.outcomes ?? [];
                        const isBinary = outcomes.length <= 2;
                        // Multi-outcome (neg-risk) markets: the YES/NO bar is meaningless, so
                        // list the leading outcomes by odds instead (the modal shows them all).
                        const ranked = outcomes
                          .map((name, i) => ({ name, odds: m.odds?.[i] ?? 0 }))
                          .sort((a, b) => b.odds - a.odds);
                        const shown = ranked.slice(0, 3);
                        return (
                          <div key={m.id} className="pmkt-mini">
                            <div className="pmkt-mini-label">{m.label || m.question}</div>
                            {isBinary ? (
                              <div className="pmkt-mini-odds">
                                <div className="pmkt-odds-bar">
                                  <div className="pmkt-odds-fill" style={{ width: `${pct}%` }} />
                                </div>
                                <div className="pmkt-odds-labels">
                                  <span className="pmkt-odds-yes">{outcomes[0] ?? "YES"} {pct}%</span>
                                  <span className="pmkt-odds-no">{outcomes[1] ?? "NO"} {100 - pct}%</span>
                                </div>
                              </div>
                            ) : (
                              <div className="pmkt-mini-odds">
                                {shown.map((o) => (
                                  <div key={o.name} className="pmkt-outcome-row">
                                    <span className="pmkt-outcome-row-name">{o.name}</span>
                                    <div className="pmkt-odds-bar pmkt-odds-bar--slim">
                                      <div
                                        className="pmkt-odds-fill"
                                        style={{ width: `${Math.round(o.odds * 100)}%` }}
                                      />
                                    </div>
                                    <span className="pmkt-outcome-row-pct">{Math.round(o.odds * 100)}%</span>
                                  </div>
                                ))}
                                {ranked.length > shown.length && (
                                  <span className="pmkt-outcome-more">
                                    +{ranked.length - shown.length} more outcomes
                                  </span>
                                )}
                              </div>
                            )}
                            <button className="pmkt-mini-btn" onClick={() => setSelected(m)}>
                              Trade Privately
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}

        <footer className="pmkt-foot">
          Live data from Polymarket’s public Gamma API, grouped by event. Trading routes through
          Siphon’s shielded vault; the order that reaches Polymarket is public, the trader behind it
          is not.
        </footer>
      </div>

      {selected && <PrivateTradeModal market={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
