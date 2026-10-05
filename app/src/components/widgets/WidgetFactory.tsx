"use client";

import { type PlacedWidget } from "@/components/widgets/config/grid";
import { FearGreedWidget } from "@/components/widgets/fear-greed";
import {
  DominanceWidget,
  MarketCapWidget,
  MarketVolumeWidget,
} from "@/components/widgets/market";
import { NewsGlance } from "@/components/widgets/news";
import { RunsPanel } from "@/components/widgets/primitives/RunsPanel";
import { PredictionsPanel } from "@/components/widgets/primitives/PredictionsPanel";
import { StrategiesPanel } from "@/components/widgets/primitives/StrategiesPanel";
import { SwapPanel } from "@/components/widgets/primitives/SwapPanel";
import { TradingViewWidget } from "@/components/widgets/chart";
import { TopCoinsPanel } from "@/components/widgets/coins";
import { WalletPanel } from "@/components/widgets/primitives/WalletPanel";

function NewsWidget() {
  return (
    <div id="news-glance" className="widget-hover widget-card widget-card--compact widget-card--news">
      <div className="widget-card-body widget-card-body--news">
        <NewsGlance />
      </div>
    </div>
  );
}

/** Dense layout for narrow/tall tiles — full chrome only on 2×2+ footprints. */
function isCompactGlance(size: PlacedWidget["size"]) {
  return size === "1x1" || size === "1x2";
}

export function renderWidget(p: PlacedWidget) {
  const sectionId = p.anchorId;
  const compact = isCompactGlance(p.size);
  switch (p.kind) {
    case "coins":
      return <TopCoinsPanel sectionId={sectionId} />;
    case "opportunities":
      return <StrategiesPanel sectionId={sectionId} size={p.size} />;
    case "wallet":
      return <WalletPanel sectionId={sectionId} size={p.size} />;
    case "fear-greed":
      return <FearGreedWidget />;
    case "market-cap":
      return <MarketCapWidget />;
    case "market-volume":
      return <MarketVolumeWidget />;
    case "dominance":
      return <DominanceWidget />;
    case "news":
      return <NewsWidget />;
    case "swap":
      return <SwapPanel compact={compact} />;
    case "runs":
      return <RunsPanel compact={compact} />;
    case "predictions":
      return <PredictionsPanel compact={compact} />;
    case "chart":
      return <TradingViewWidget sectionId={sectionId} />;
    default:
      return null;
  }
}
