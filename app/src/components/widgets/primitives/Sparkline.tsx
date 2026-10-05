"use client";

type SparklineProps = {
  /** Fallback when `values` is omitted — two fixed decorative shapes. */
  up?: boolean;
  /** Real series (e.g. sampled market cap). Preferred over `up`. */
  values?: number[];
  className?: string;
  /** Stretch sparkline to the full width of its container. */
  fullWidth?: boolean;
};

const VIEW_W = 96;
const VIEW_H = 28;
const PAD_Y = 2;

function pointsFromValues(values: number[]): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const n = values.length;
  return values
    .map((v, i) => {
      const x = n === 1 ? VIEW_W / 2 : (i / (n - 1)) * VIEW_W;
      const y = VIEW_H - PAD_Y - ((v - min) / range) * (VIEW_H - PAD_Y * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

const UP_POINTS = "0,28 12,24 24,26 36,18 48,20 60,8 72,12 84,4 96,0";
const DOWN_POINTS = "0,4 12,8 24,6 36,14 48,12 60,22 72,18 84,26 96,28";

/** Lightweight SVG sparkline — theme neutrals; optional real `values` series. */
export function Sparkline({
  up = true,
  values,
  className = "",
  fullWidth = false,
}: SparklineProps) {
  const hasSeries = Array.isArray(values) && values.length >= 2;
  const seriesUp = hasSeries ? values![values!.length - 1] >= values![0] : up;
  const stroke = seriesUp ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.4)";
  const points = hasSeries
    ? pointsFromValues(values!)
    : seriesUp
      ? UP_POINTS
      : DOWN_POINTS;

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className={`widget-sparkline ${fullWidth ? "widget-sparkline--full" : "widget-sparkline--compact"} ${className}`.trim()}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}
