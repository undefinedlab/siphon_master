"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type UTCTimestamp,
  type Time,
} from "lightweight-charts";
import { useOhlc, type Candle } from "./useOhlc";

export interface ChartOverlay {
  kind: "line" | "band" | "markers";
  price?: number; // line
  low?: number; // band
  high?: number; // band
  times?: UTCTimestamp[]; // markers
  color?: string;
  title?: string;
}

interface StrategyChartProps {
  coin: string;
  days: number;
  overlays?: ChartOverlay[];
  showMA?: boolean; // 7 & 30 period simple moving averages
  showLegend?: boolean; // crosshair OHLC readout
  height?: number; // fixed height; omit to fill parent
  className?: string;
}

function sma(candles: Candle[], period: number) {
  if (candles.length < period) return [];
  const out: { time: Time; value: number }[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}

const fmtUsd = (n: number) =>
  `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 4 : 2 })}`;

/**
 * Reusable candlestick chart with optional moving averages, a crosshair OHLC
 * legend, and strategy overlays (target price lines, range bands, DCA markers).
 * Shared by the Markets tab and the strategy DetailsModal.
 */
export default function StrategyChart({
  coin,
  days,
  overlays = [],
  showMA = false,
  showLegend = false,
  height,
  className,
}: StrategyChartProps) {
  const { candles, loading, error, stale } = useOhlc(coin, days);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const maSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const [legend, setLegend] = useState<Candle | null>(null);

  // Create chart once.
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
      autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });

    chartRef.current = chart;
    candleSeriesRef.current = series;

    const onMove = (param: Parameters<Parameters<IChartApi["subscribeCrosshairMove"]>[0]>[0]) => {
      const d = param.seriesData.get(series) as Candle | undefined;
      setLegend(d ?? null);
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      maSeriesRef.current = [];
      priceLinesRef.current = [];
      markersRef.current = null;
    };
  }, []);

  // Set candle data.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !candles.length) return;
    series.setData(candles);
    chartRef.current?.timeScale().fitContent();
    setLegend(candles[candles.length - 1]);
  }, [candles]);

  // Moving averages.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    maSeriesRef.current.forEach((s) => chart.removeSeries(s));
    maSeriesRef.current = [];
    if (!showMA || !candles.length) return;

    const configs = [
      { period: 7, color: "#f6c343" },
      { period: 30, color: "#5b8def" },
    ];
    for (const c of configs) {
      const data = sma(candles, c.period);
      if (!data.length) continue;
      const line = chart.addSeries(LineSeries, {
        color: c.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(data);
      maSeriesRef.current.push(line);
    }
  }, [showMA, candles]);

  // Overlays: price lines, bands (two lines), markers.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    priceLinesRef.current.forEach((l) => series.removePriceLine(l));
    priceLinesRef.current = [];
    markersRef.current?.setMarkers([]);

    if (!candles.length) return;

    // Guard against nonsense levels (e.g. a ratio mistaken for a USD price):
    // only draw price lines within 0.1x–10x of the latest close.
    const last = candles[candles.length - 1].close;
    const sane = (p?: number): p is number =>
      typeof p === "number" && isFinite(p) && p > last * 0.1 && p < last * 10;

    const addLine = (price: number, color: string, title: string) =>
      priceLinesRef.current.push(
        series.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title,
        })
      );

    const markers: SeriesMarker<Time>[] = [];

    for (const o of overlays) {
      const color = o.color || "#f6c343";
      if (o.kind === "line" && sane(o.price)) {
        addLine(o.price, color, o.title || "Target");
      } else if (o.kind === "band") {
        if (sane(o.low)) addLine(o.low, color, o.title ? `${o.title} low` : "Low");
        if (sane(o.high)) addLine(o.high, color, o.title ? `${o.title} high` : "High");
      } else if (o.kind === "markers" && o.times?.length) {
        for (const t of o.times) {
          markers.push({
            time: t,
            position: "belowBar",
            color,
            shape: "arrowUp",
            text: o.title || "",
          });
        }
      }
    }

    if (markers.length) {
      if (!markersRef.current) {
        markersRef.current = createSeriesMarkers(series, markers);
      } else {
        markersRef.current.setMarkers(markers);
      }
    }
  }, [overlays, candles]);

  return (
    <div className={className} style={{ position: "relative", height: height ?? "100%", width: "100%" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      {showLegend && legend && (
        <div className="strategy-chart-legend">
          <span>O {fmtUsd(legend.open)}</span>
          <span>H {fmtUsd(legend.high)}</span>
          <span>L {fmtUsd(legend.low)}</span>
          <span className={legend.close >= legend.open ? "up" : "down"}>
            C {fmtUsd(legend.close)}
          </span>
        </div>
      )}

      {loading && !candles.length && (
        <div className="strategy-chart-overlay">Loading {coin} candles…</div>
      )}
      {error && !candles.length && (
        <div className="strategy-chart-overlay error">{error}</div>
      )}
      {stale && candles.length > 0 && (
        <div className="strategy-chart-stale">cached</div>
      )}
    </div>
  );
}
