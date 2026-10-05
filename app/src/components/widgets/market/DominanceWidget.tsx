"use client";

import { useMarketGlobal } from "./useMarketGlobal";

export function DominanceWidget() {
  const { data, loading, isLive } = useMarketGlobal();
  const btc = data?.btc_dominance_pct ?? null;
  const eth = data?.eth_dominance_pct ?? null;

  const footnote = loading
    ? "Loading dominance…"
    : !isLive
      ? "Unable to load dominance"
      : null;

  return (
    <div className="widget-hover widget-card widget-card--compact widget-card--glance">
      <p className="widget-card-eyebrow">Dominance</p>
      <div className="widget-card-body widget-card-body--dominance justify-center py-0.5">
        <div className="widget-dominance-row">
          <span className="widget-dominance-item">
            <span className="widget-dominance-label">BTC</span>
            <span className="widget-stat-value widget-stat-value--glance widget-stat-value--dominance">
              {btc != null ? `${btc.toFixed(1)}%` : "…"}
            </span>
          </span>
          <span className="widget-dominance-divider" aria-hidden />
          <span className="widget-dominance-item">
            <span className="widget-dominance-label">ETH</span>
            <span className="widget-stat-value widget-stat-value--glance widget-stat-value--dominance">
              {eth != null ? `${eth.toFixed(1)}%` : "…"}
            </span>
          </span>
        </div>
      </div>
      {footnote ? <p className="widget-card-footnote">{footnote}</p> : null}
    </div>
  );
}
