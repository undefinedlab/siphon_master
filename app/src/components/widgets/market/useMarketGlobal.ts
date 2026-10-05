"use client";

import { createPollingStore } from "@/components/widgets/lib/createPollingStore";
import type { MarketGlobalData } from "./types";

function getAsiBase(): string {
  return (
    process.env.NEXT_PUBLIC_ASI_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_ASI_API?.trim() ||
    ""
  );
}

async function fetchAsiMarket(): Promise<MarketGlobalData | null> {
  const base = getAsiBase();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/v1/widget/market-size`);
    if (!r.ok) return null;
    const json = (await r.json()) as Partial<MarketGlobalData>;
    if (json.global_cap_usd == null && json.volume_24h_usd == null) return null;
    return {
      global_cap_usd: json.global_cap_usd ?? null,
      volume_24h_usd: json.volume_24h_usd ?? null,
      market_cap_change_24h_pct: json.market_cap_change_24h_pct ?? null,
      btc_dominance_pct: json.btc_dominance_pct ?? null,
      eth_dominance_pct: json.eth_dominance_pct ?? null,
    };
  } catch {
    return null;
  }
}

async function fetchLocalMarket(): Promise<MarketGlobalData | null> {
  try {
    const r = await fetch("/api/market-global");
    if (!r.ok) return null;
    return (await r.json()) as MarketGlobalData;
  } catch {
    return null;
  }
}

async function loadMarketGlobal(): Promise<MarketGlobalData | null> {
  const asi = await fetchAsiMarket();
  if (asi?.global_cap_usd != null || asi?.volume_24h_usd != null) return asi;
  return fetchLocalMarket();
}

const useMarketGlobalStore = createPollingStore(loadMarketGlobal);

export function useMarketGlobal() {
  return useMarketGlobalStore();
}
