"use client";

export type EthPriceSnapshot = {
  ethUsd: number | null;
  updatedAt: number | null;
};

const POLL_MS = 300_000;

let snapshot: EthPriceSnapshot = { ethUsd: null, updatedAt: null };
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;

function notify() {
  listeners.forEach((fn) => fn());
}

async function loadEthPrice(): Promise<void> {
  try {
    const res = await fetch("/api/price?coin=all");
    if (!res.ok) return;
    const data = (await res.json()) as { prices?: { ETH?: number } };
    const eth = data.prices?.ETH;
    if (typeof eth === "number" && eth > 0) {
      snapshot = { ethUsd: eth, updatedAt: Date.now() };
      notify();
      void import("./tokenPrices").then(({ setLiveEthUsd }) => setLiveEthUsd(eth));
    }
  } catch {
    /* keep last snapshot */
  }
}

export function getEthPriceSnapshot(): EthPriceSnapshot {
  return snapshot;
}

export function subscribeEthPrice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Refresh when the tab regains focus (covers the gap left by pausing the poll while hidden).
function onVisible() {
  if (!document.hidden && refCount > 0) void loadEthPrice();
}

/** Start background polling when the first subscriber mounts. */
export function retainEthPricePolling(): () => void {
  refCount += 1;
  if (refCount === 1) {
    void loadEthPrice();
    // Skip fetches while backgrounded — a hidden always-open tab shouldn't poll forever.
    pollTimer = setInterval(() => { if (!document.hidden) void loadEthPrice(); }, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}
