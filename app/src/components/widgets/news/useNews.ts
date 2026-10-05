"use client";

import { createPollingStore } from "@/components/widgets/lib/createPollingStore";
import type { NewsItem } from "./types";

function getAsiBase(): string {
  return (
    process.env.NEXT_PUBLIC_ASI_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_ASI_API?.trim() ||
    ""
  );
}

async function fetchAsiNews(): Promise<NewsItem[] | null> {
  const base = getAsiBase();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/v1/widget/news`);
    if (!r.ok) return null;
    const json = (await r.json()) as NewsItem[];
    return Array.isArray(json) && json.length > 0 ? json : null;
  } catch {
    return null;
  }
}

async function fetchLocalNews(): Promise<NewsItem[] | null> {
  try {
    const r = await fetch("/api/news");
    if (!r.ok) return null;
    const json = (await r.json()) as NewsItem[];
    return Array.isArray(json) && json.length > 0 ? json : null;
  } catch {
    return null;
  }
}

async function loadNews(): Promise<NewsItem[] | null> {
  const asi = await fetchAsiNews();
  if (asi) return asi;
  return fetchLocalNews();
}

const useNewsStore = createPollingStore(loadNews);

export function useNews() {
  return useNewsStore();
}
