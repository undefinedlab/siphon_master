"use client";

import { useMemo, useState } from "react";
import {
  buildTradingViewEmbedSrc,
  CHART_EMBED_DEFAULT_INTERVAL,
  CHART_INTERVALS,
  type ChartIntervalId,
} from "./embedOptions";

const SYMBOL_TABS = [
  { id: "BINANCE:BTCUSDT", label: "BTC" },
  { id: "BINANCE:ETHUSDT", label: "ETH" },
] as const;

export function TradingViewWidget({ sectionId }: { sectionId?: string }) {
  const [symbol, setSymbol] = useState<string>(SYMBOL_TABS[0].id);
  const [interval, setInterval] = useState<ChartIntervalId>(CHART_EMBED_DEFAULT_INTERVAL);
  const src = useMemo(
    () => buildTradingViewEmbedSrc(symbol, interval),
    [symbol, interval],
  );

  return (
    <div
      {...(sectionId ? { id: sectionId } : {})}
      className="widget-hover widget-card widget-card--chart"
    >
      <div className="widget-card-header widget-card-header--chart">
        <div>
          <p className="widget-card-title">Chart</p>
          <p className="widget-card-subtitle">TradingView</p>
        </div>
        <div className="widget-chart-filters">
          <div className="widget-tabs" role="tablist" aria-label="Chart symbol">
            {SYMBOL_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={symbol === t.id}
                onClick={() => setSymbol(t.id)}
                className={`widget-tab ${symbol === t.id ? "widget-tab--active" : ""}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="widget-tabs" role="tablist" aria-label="Chart timeframe">
            {CHART_INTERVALS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={interval === t.id}
                onClick={() => setInterval(t.id)}
                className={`widget-tab ${interval === t.id ? "widget-tab--active" : ""}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="widget-chart-embed scrollbar-hide">
        <iframe
          key={`${symbol}-${interval}`}
          title={`TradingView chart — ${symbol} ${interval}`}
          src={src}
          className="widget-chart-iframe"
          allow="fullscreen"
          scrolling="no"
        />
      </div>
    </div>
  );
}
