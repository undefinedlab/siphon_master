"use client";

import { useEffect, useState } from "react";
import type { UTCTimestamp } from "lightweight-charts";

export interface Candle {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface OhlcState {
  candles: Candle[];
  loading: boolean;
  error: string | null;
  stale: boolean;
}

// Simple module-level cache so repeated mounts (cards, modal, markets tab)
// for the same coin/days don't each fire a request.
const memo = new Map<string, Candle[]>();

/**
 * Fetch OHLC candles for a coin/timeframe from /api/ohlc.
 * Shared by StrategyChart, the comparison view, and sparklines.
 */
export function useOhlc(coin: string, days: number): OhlcState {
  const [state, setState] = useState<OhlcState>(() => {
    const cached = memo.get(`${coin}:${days}`);
    return { candles: cached || [], loading: !cached, error: null, stale: false };
  });

  useEffect(() => {
    let active = true;
    const key = `${coin}:${days}`;
    const cached = memo.get(key);
    if (cached) {
      setState({ candles: cached, loading: false, error: null, stale: false });
    } else {
      setState((s) => ({ ...s, loading: true, error: null }));
    }

    (async () => {
      try {
        const res = await fetch(`/api/ohlc?coin=${coin}&days=${days}`);
        if (!res.ok) throw new Error(`OHLC request failed: ${res.status}`);
        const data = await res.json();
        const candles: Candle[] = data.candles || [];
        if (!active) return;
        if (candles.length) {
          memo.set(key, candles);
          setState({ candles, loading: false, error: null, stale: !!data.stale });
        } else {
          setState({ candles: [], loading: false, error: "No chart data available.", stale: false });
        }
      } catch (e) {
        if (!active) return;
        console.error("[useOhlc] Failed to load candles:", e);
        // Keep any cached candles visible rather than blanking the chart.
        setState((s) => ({
          candles: s.candles,
          loading: false,
          error: "Failed to load chart data.",
          stale: s.candles.length > 0,
        }));
      }
    })();

    return () => {
      active = false;
    };
  }, [coin, days]);

  return state;
}
