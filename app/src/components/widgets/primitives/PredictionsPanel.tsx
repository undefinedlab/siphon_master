"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { PolymarketMarket } from "@/app/api/polymarket/markets/route";
import { useIsAdmin } from "@/lib/adminWallet";
import "./PredictionsPanel.css";

interface PredictionsPanelProps {
  compact?: boolean;
}

/** Compact dashboard widget: teaser of live Polymarket markets → routes to the /markets page. */
export function PredictionsPanel({ compact = false }: PredictionsPanelProps) {
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const [teasers, setTeasers] = useState<PolymarketMarket[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/polymarket/markets?limit=4");
        const data = await res.json();
        if (!cancelled && res.ok) setTeasers((data.markets ?? []).slice(0, compact ? 3 : 4));
      } catch {
        /* best-effort teaser */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compact, isAdmin]);

  const go = () => { if (isAdmin) router.push("/markets"); };

  if (!isAdmin) {
    return (
      <div className="widget-card widget-card--compact widget-pred-card">
        <div className="widget-card-header widget-card-header--compact widget-pred-header">
          <div>
            <p className="widget-card-title">Private Markets</p>
            <p className="widget-card-subtitle">Coming soon</p>
          </div>
        </div>
        <div className="widget-pred-body">
          <p className="widget-pred-empty">Coming soon</p>
        </div>
      </div>
    );
  }

  return (
    <div className="widget-hover widget-card widget-card--compact widget-pred-card">
      <div className="widget-card-header widget-card-header--compact widget-pred-header">
        <div>
          <p className="widget-card-title">Private Markets</p>
          <p className="widget-card-subtitle">Powered by Polymarket</p>
        </div>
        <button type="button" className="widget-pred-open" onClick={go} aria-label="Open Private Markets">
          →
        </button>
      </div>

      <div className="widget-pred-body" onClick={go} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") go(); }}>
        {loaded && teasers.length === 0 ? (
          <p className="widget-pred-empty">Live markets · tap to explore</p>
        ) : (
          teasers.map((m) => {
            const pct = Math.round((m.odds?.[0] ?? 0) * 100);
            return (
              <div key={m.id} className="widget-pred-row">
                <span className="widget-pred-q">{m.question}</span>
                <span className="widget-pred-pct">{pct}%</span>
              </div>
            );
          })
        )}
        <span className="widget-pred-cta">Trade your thesis, privately →</span>
      </div>
    </div>
  );
}
