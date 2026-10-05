"use client";

import React, { useEffect, useState } from "react";
import StrategyChart from "../../charts/StrategyChart";
import ComparisonChart from "../../charts/ComparisonChart";
import Sparkline from "../../charts/Sparkline";
import { type Candle } from "../../charts/useOhlc";
import { fetchCoinPrices } from "../Discover/price_utils";
import { strategyList } from "../Discover/strategies";
import "../../charts/charts.css";
import "./Markets.css";

interface MarketsProps {
  isLoaded?: boolean;
  setViewMode: (mode: "blueprint" | "run" | "discover" | "userdash" | "markets") => void;
}

const ASSETS = ["ETH", "BTC", "SOL"] as const;
type Asset = (typeof ASSETS)[number];

const TIMEFRAMES: { label: string; days: number }[] = [
  { label: "1D", days: 1 },
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "1Y", days: 365 },
];

const SPOT_POLL_MS = 15000;

export default function Markets({ setViewMode }: MarketsProps) {
  const [asset, setAsset] = useState<Asset>("ETH");
  const [days, setDays] = useState<number>(7);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [showMA, setShowMA] = useState(false);
  const [compare, setCompare] = useState(false);
  // Candles for all assets at the current timeframe — powers tab sparklines,
  // the comparison view, and the window-change badge.
  const [seriesByCoin, setSeriesByCoin] = useState<Record<string, Candle[]>>({});

  // Load candles for every asset whenever the timeframe changes.
  useEffect(() => {
    let active = true;
    (async () => {
      const entries = await Promise.all(
        ASSETS.map(async (a) => {
          try {
            const res = await fetch(`/api/ohlc?coin=${a}&days=${days}`);
            if (!res.ok) return [a, [] as Candle[]] as const;
            const data = await res.json();
            return [a, (data.candles || []) as Candle[]] as const;
          } catch {
            return [a, [] as Candle[]] as const;
          }
        })
      );
      if (active) setSeriesByCoin(Object.fromEntries(entries));
    })();
    return () => {
      active = false;
    };
  }, [days]);

  // Poll live spot prices.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      const p = await fetchCoinPrices();
      if (active && Object.keys(p).length) setPrices(p);
    };
    poll();
    const id = setInterval(poll, SPOT_POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const spot = prices[asset];
  const tfLabel = TIMEFRAMES.find((t) => t.days === days)?.label;

  const closesFor = (a: string) => (seriesByCoin[a] || []).map((c) => c.close);
  const windowChange = (a: string): number | null => {
    const closes = closesFor(a);
    if (closes.length < 2) return null;
    return ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  };
  const change = windowChange(asset);

  const relevantStrategies = strategyList
    .filter((s) => s.category === "trading" || s.category === "arbitrage")
    .slice(0, 6);

  return (
    <div className="markets-root">
      {/* Header: asset tabs (with sparklines) + live spot */}
      <div className="markets-header">
        <div className="markets-asset-tabs">
          {ASSETS.map((a) => {
            const ch = windowChange(a);
            return (
              <button
                key={a}
                className={`markets-asset-tab ${asset === a ? "active" : ""}`}
                onClick={() => setAsset(a)}
              >
                <div className="markets-asset-tab-info">
                  <span className="markets-asset-tab-sym">{a}</span>
                  {prices[a] != null && (
                    <span className="markets-asset-tab-price">
                      ${prices[a].toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  )}
                </div>
                <Sparkline data={closesFor(a)} width={72} height={26} />
                {ch != null && (
                  <span className={`markets-asset-tab-chg ${ch >= 0 ? "up" : "down"}`}>
                    {ch >= 0 ? "+" : ""}
                    {ch.toFixed(1)}%
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="markets-spot">
          <span className="markets-spot-pair">{asset} / USD</span>
          <span className="markets-spot-price">
            {spot != null
              ? `$${spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
              : "—"}
          </span>
          {change != null && (
            <span className={`markets-spot-change ${change >= 0 ? "up" : "down"}`}>
              {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
              <span className="markets-spot-change-window"> ({tfLabel})</span>
            </span>
          )}
        </div>
      </div>

      <div className="markets-body">
        {/* Chart panel */}
        <div className="markets-chart-panel">
          <div className="markets-controls">
            <div className="markets-timeframes">
              {TIMEFRAMES.map((t) => (
                <button
                  key={t.label}
                  className={`markets-tf-btn ${days === t.days ? "active" : ""}`}
                  onClick={() => setDays(t.days)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="markets-toggles">
              <button
                className={`markets-toggle ${showMA ? "active" : ""}`}
                onClick={() => setShowMA((v) => !v)}
                disabled={compare}
                title="Moving averages (7 / 30)"
              >
                MA
              </button>
              <button
                className={`markets-toggle ${compare ? "active" : ""}`}
                onClick={() => setCompare((v) => !v)}
                title="Compare assets (% change)"
              >
                Compare %
              </button>
            </div>
          </div>

          <div className="markets-chart-wrap">
            {compare ? (
              <ComparisonChart seriesByCoin={seriesByCoin} />
            ) : (
              <StrategyChart key={asset} coin={asset} days={days} showMA={showMA} showLegend />
            )}
          </div>
        </div>

        {/* Strategy rail */}
        <aside className="markets-rail">
          <div className="markets-rail-title">Strategies for {asset}</div>
          <div className="markets-rail-sub">Trade these trends without a trace</div>
          {relevantStrategies.map((s) => (
            <div key={s.name} className="markets-strat-card">
              <div className="markets-strat-name">{s.name}</div>
              <div className="markets-strat-desc">{s.description}</div>
              <div className="markets-strat-meta">
                <span className="markets-strat-tag">{s.category}</span>
                <span className="markets-strat-profit">{s.profit}</span>
              </div>
              <button className="markets-strat-cta" onClick={() => setViewMode("discover")}>
                View in Discover →
              </button>
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
