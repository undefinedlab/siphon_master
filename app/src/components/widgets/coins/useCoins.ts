"use client";

import { createPollingStore } from "@/components/widgets/lib/createPollingStore";
import type { CoinItem } from "./types";

function getAsiBase(): string {
  return (
    process.env.NEXT_PUBLIC_ASI_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_ASI_API?.trim() ||
    ""
  );
}

async function fetchAsiCoins(): Promise<CoinItem[] | null> {
  const base = getAsiBase();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/v1/widget/coins`);
    if (!r.ok) return null;
    const json = (await r.json()) as CoinItem[];
    return Array.isArray(json) && json.length > 0 ? json : null;
  } catch {
    return null;
  }
}

async function fetchLocalCoins(): Promise<CoinItem[] | null> {
  try {
    const r = await fetch("/api/coins");
    if (!r.ok) return null;
    const json = (await r.json()) as CoinItem[];
    return Array.isArray(json) && json.length > 0 ? json : null;
  } catch {
    return null;
  }
}

async function loadCoins(): Promise<CoinItem[] | null> {
  const asi = await fetchAsiCoins();
  if (asi) return asi;
  return fetchLocalCoins();
}

const useCoinsStore = createPollingStore(loadCoins);

export function useCoins() {
  return useCoinsStore();
}
