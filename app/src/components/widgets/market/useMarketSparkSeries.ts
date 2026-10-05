"use client";

import { useEffect, useState } from "react";
import {
  readMarketSparkSamples,
  recordMarketSparkSample,
  sparkValuesFor,
  type MarketSparkSample,
} from "./marketSparkHistory";
import { useMarketGlobal } from "./useMarketGlobal";

function seriesFrom(samples: MarketSparkSample[], key: "cap" | "vol"): number[] {
  return samples.map((s) => s[key]);
}

/**
 * Spark series for market glance widgets — fed by the existing market-global poll only.
 */
export function useMarketSparkSeries() {
  const { data } = useMarketGlobal();
  const [samples, setSamples] = useState<MarketSparkSample[]>(() =>
    typeof window !== "undefined" ? readMarketSparkSamples() : [],
  );

  useEffect(() => {
    if (data?.global_cap_usd == null || data?.volume_24h_usd == null) return;
    setSamples(recordMarketSparkSample(data.global_cap_usd, data.volume_24h_usd));
  }, [data?.global_cap_usd, data?.volume_24h_usd]);

  const changePct = data?.market_cap_change_24h_pct ?? null;

  return {
    capValues: sparkValuesFor(seriesFrom(samples, "cap"), changePct),
    // Volume has no dedicated 24h % on the payload — reuse market-cap change as a soft
    // direction until local volume samples accumulate.
    volValues: sparkValuesFor(seriesFrom(samples, "vol"), changePct),
    changePct,
  };
}
