"use client";

import { createPollingStore } from "@/components/widgets/lib/createPollingStore";
import type { FearGreedData } from "./types";

function getAsiBase(): string {
  return (
    process.env.NEXT_PUBLIC_ASI_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_ASI_API?.trim() ||
    ""
  );
}

async function fetchAsiFearGreed(): Promise<FearGreedData | null> {
  const base = getAsiBase();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/v1/widget/fear-greed`);
    if (!r.ok) return null;
    const json = (await r.json()) as Partial<FearGreedData>;
    if (typeof json.value !== "number" || !json.label) return null;
    return {
      value: json.value,
      label: json.label,
      updatedAt: json.updatedAt ?? null,
    };
  } catch {
    return null;
  }
}

async function fetchLocalFearGreed(): Promise<FearGreedData | null> {
  try {
    const r = await fetch("/api/fear-greed");
    if (!r.ok) return null;
    return (await r.json()) as FearGreedData;
  } catch {
    return null;
  }
}

async function loadFearGreed(): Promise<FearGreedData | null> {
  const asi = await fetchAsiFearGreed();
  if (asi) return asi;
  return fetchLocalFearGreed();
}

const useFearGreedStore = createPollingStore(loadFearGreed);

export function useFearGreed() {
  return useFearGreedStore();
}
