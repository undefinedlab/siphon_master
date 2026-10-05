"use client";

import { FearGreedGauge } from "@/components/widgets/primitives/FearGreedGauge";
import { useFearGreed } from "./useFearGreed";

export function FearGreedWidget() {
  const { data, loading, isLive } = useFearGreed();

  const value = data?.value ?? null;
  const footnote = loading
    ? "Loading sentiment…"
    : !isLive
      ? "Unable to load index"
      : null;

  return (
    <div className="widget-hover widget-card widget-card--compact widget-card--glance widget-card--fear-greed">
      <p className="widget-card-eyebrow">Fear &amp; Greed</p>
      <div className="widget-card-body min-h-0 flex-1">
        {value != null ? (
          <FearGreedGauge value={value} label={data?.label} />
        ) : (
          <p className="widget-stat-value widget-stat-value--glance text-[var(--defi-text-muted)]">
            …
          </p>
        )}
      </div>
      {footnote ? <p className="widget-card-footnote">{footnote}</p> : null}
    </div>
  );
}
