"use client";

import { Sparkline } from "@/components/widgets/primitives/Sparkline";
import { formatUsdCompact } from "./formatUsd";
import { useMarketGlobal } from "./useMarketGlobal";
import { useMarketSparkSeries } from "./useMarketSparkSeries";

export function MarketVolumeWidget() {
  const { data, loading, isLive } = useMarketGlobal();
  const { volValues, changePct } = useMarketSparkSeries();
  const vol = data?.volume_24h_usd ?? null;
  const volUp = (changePct ?? 0) >= 0;

  const footnote = loading
    ? "Loading volume…"
    : !isLive
      ? "Unable to load volume"
      : null;

  return (
    <div className="widget-hover widget-card widget-card--compact widget-card--glance">
      <p className="widget-card-eyebrow">24h volume</p>
      <div className="widget-card-body widget-card-body--stat-glance py-0.5">
        <p className="widget-stat-value widget-stat-value--glance">
          {vol != null ? formatUsdCompact(vol) : "…"}
        </p>
        <Sparkline
          up={volUp}
          values={volValues}
          fullWidth
          className="widget-stat-sparkline"
        />
      </div>
      {footnote ? <p className="widget-card-footnote">{footnote}</p> : null}
    </div>
  );
}
