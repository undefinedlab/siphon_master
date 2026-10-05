"use client";

import { Sparkline } from "@/components/widgets/primitives/Sparkline";
import { formatUsdCompact } from "./formatUsd";
import { useMarketGlobal } from "./useMarketGlobal";
import { useMarketSparkSeries } from "./useMarketSparkSeries";

export function MarketCapWidget() {
  const { data, loading, isLive } = useMarketGlobal();
  const { capValues, changePct } = useMarketSparkSeries();
  const cap = data?.global_cap_usd ?? null;
  const capUp = (changePct ?? 0) >= 0;

  const footnote = loading
    ? "Loading market cap…"
    : !isLive
      ? "Unable to load market cap"
      : changePct != null
        ? `24h ${capUp ? "+" : ""}${changePct.toFixed(2)}%`
        : null;

  return (
    <div className="widget-hover widget-card widget-card--compact widget-card--glance">
      <p className="widget-card-eyebrow">Market cap</p>
      <div className="widget-card-body widget-card-body--stat-glance py-0.5">
        <p className="widget-stat-value widget-stat-value--glance">
          {cap != null ? formatUsdCompact(cap) : "…"}
        </p>
        <Sparkline
          up={capUp}
          values={capValues}
          fullWidth
          className="widget-stat-sparkline"
        />
      </div>
      {footnote ? <p className="widget-card-footnote">{footnote}</p> : null}
    </div>
  );
}
