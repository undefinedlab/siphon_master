"use client";

import React, { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { type Candle } from "./useOhlc";

const SERIES_COLORS: Record<string, string> = {
  ETH: "#5b8def",
  BTC: "#f6c343",
  SOL: "#14f195",
};

interface ComparisonChartProps {
  // Pre-fetched candles per coin (Markets already loads these for sparklines).
  seriesByCoin: Record<string, Candle[]>;
  className?: string;
}

/**
 * Normalizes each coin's closes to % change from the window start and plots
 * them together, so relative performance is comparable on one axis.
 */
export default function ComparisonChart({ seriesByCoin, className }: ComparisonChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9aa0a6",
        fontFamily: "inherit",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true },
      localization: { priceFormatter: (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%` },
      autoSize: true,
    });
    chartRef.current = chart;

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const added = Object.entries(seriesByCoin).flatMap(([coin, candles]) => {
      if (!candles.length) return [];
      const base = candles[0].close;
      if (!base) return [];
      const data: { time: Time; value: number }[] = candles.map((c) => ({
        time: c.time,
        value: ((c.close - base) / base) * 100,
      }));
      const line = chart.addSeries(LineSeries, {
        color: SERIES_COLORS[coin] || "#9aa0a6",
        lineWidth: 2,
        priceLineVisible: false,
      });
      line.setData(data);
      return [line];
    });
    chart.timeScale().fitContent();

    return () => {
      // Guard: the create-effect cleanup may have already removed the chart.
      if (chartRef.current !== chart) return;
      added.forEach((s) => chart.removeSeries(s));
    };
  }, [seriesByCoin]);

  return (
    <div className={className} style={{ position: "relative", height: "100%", width: "100%" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      <div className="strategy-chart-legend">
        {Object.keys(seriesByCoin).map((coin) => (
          <span key={coin} style={{ color: SERIES_COLORS[coin] || "#9aa0a6" }}>
            ● {coin}
          </span>
        ))}
      </div>
    </div>
  );
}
