"use client";

import { useMemo, useSyncExternalStore } from "react";
import { strategyList, type StrategyMetadata } from "@/components/navs/Discover/strategies";
import type { SizePreset } from "@/components/widgets/config/grid";
import { SIZE_TO_GRID } from "@/components/widgets/config/grid";

function subscribeMobileLayout(onChange: () => void) {
  const mq = window.matchMedia("(max-width: 768px)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getMobileLayoutSnapshot() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function useMobileLayout() {
  return useSyncExternalStore(subscribeMobileLayout, getMobileLayoutSnapshot, () => false);
}

const STRATEGY_BRIEF: Record<string, string> = {
  "Limit Order": "Buy or sell when price hits your target.",
  "DCA Accumulator": "Recurring buys on a schedule until funds run out.",
  "Grid Trading": "Several buy/sell legs spread across a price band.",
  "TWAP Executor": "Large order split into timed slices over a window.",
  "Range Grid Bot": "Auto buy low and sell high inside a set range.",
  "Stop-Loss Shield": "Exit to stablecoin if price drops below your stop.",
  "Take-Profit Lock": "Exit to stablecoin once price reaches your target.",
};

function getBrief(name: string, fallback: string): string {
  return STRATEGY_BRIEF[name] ?? fallback;
}

function sortStrategies(strategies: StrategyMetadata[]): StrategyMetadata[] {
  return [...strategies].sort((a, b) => {
    const aRank = a.isActive ? 0 : 1;
    const bRank = b.isActive ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    const aUsage = typeof a.usage === "number" ? a.usage : 0;
    const bUsage = typeof b.usage === "number" ? b.usage : 0;
    return bUsage - aUsage;
  });
}

function StrategyCard({ strategy, compact }: { strategy: StrategyMetadata; compact?: boolean }) {
  const brief = getBrief(strategy.name, strategy.description);

  const load = () => {
    if (!strategy.isActive) return;
    window.dispatchEvent(
      new CustomEvent("build-select-strategy-template", { detail: strategy.name }),
    );
  };

  return (
    <button
      type="button"
      className={`build-strategy-card ${compact ? "build-strategy-card--compact" : ""} ${strategy.isActive ? "" : "build-strategy-card--soon"}`}
      onClick={load}
      disabled={!strategy.isActive}
      title={strategy.isActive ? `Load ${strategy.name} into builder` : "Coming soon"}
    >
      <div className="build-strategy-card-top">
        <p className="build-strategy-name">{strategy.name}</p>
        {strategy.isActive ? <span className="build-strategy-cta">Load</span> : null}
      </div>
      <p className="build-strategy-brief">{brief}</p>
    </button>
  );
}

function gridColumnsForSize(size: SizePreset): 1 | 2 {
  const { col, row } = SIZE_TO_GRID[size];
  return col >= 2 && row >= 2 ? 2 : 1;
}

export function StrategiesPanel({
  sectionId,
  size = "2x2",
}: {
  sectionId?: string;
  size?: SizePreset;
}) {
  const isMobile = useMobileLayout();
  const columns = isMobile ? 1 : gridColumnsForSize(size);
  const compact = !isMobile && columns === 2;
  const strategies = useMemo(() => sortStrategies(strategyList), []);

  return (
    <div {...(sectionId ? { id: sectionId } : {})} className="widget-hover widget-card widget-card--strategies">
      <div className="widget-card-header widget-card-header--compact">
        <div>
          <p className="widget-card-title">Strategies</p>
          <p className="widget-card-subtitle">Tap a template to open in builder</p>
        </div>
      </div>
      <div
        className={`widget-strategies-list scrollbar-hide widget-strategies-list--cols-${columns}`}
      >
        {strategies.map((s) => (
          <StrategyCard key={s.name} strategy={s} compact={compact} />
        ))}
      </div>
    </div>
  );
}
