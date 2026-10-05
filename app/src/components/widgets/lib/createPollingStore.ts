"use client";

import { useSyncExternalStore } from "react";

/** Background refresh interval for dashboard widget data. */
export const WIDGET_REFRESH_MS = 3 * 60 * 1000;

type Snapshot<T> = {
  data: T | null;
  loading: boolean;
  isLive: boolean;
};

export function createPollingStore<T>(loader: () => Promise<T | null>) {
  let data: T | null = null;
  let hasLoaded = false;
  let lastFetchedAt = 0;
  let subscribers = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let inflight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  let snapshot: Snapshot<T> = {
    data: null,
    loading: true,
    isLive: false,
  };

  function syncSnapshot() {
    snapshot = {
      data,
      loading: !hasLoaded && data === null,
      isLive: data !== null,
    };
  }

  function emit() {
    syncSnapshot();
    for (const listener of listeners) listener();
  }

  function getSnapshot(): Snapshot<T> {
    return snapshot;
  }

  async function load() {
    const result = await loader();
    if (result !== null) {
      data = result;
    }
    hasLoaded = true;
    lastFetchedAt = Date.now();
    emit();
  }

  function runLoad() {
    if (inflight) return inflight;
    inflight = load().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function startPollTimer() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => {
      // Skip the /api fetch while the tab is backgrounded — no viewer, and a hidden always-open
      // tab would otherwise poll forever (the top driver of Vercel Function Invocations).
      if (typeof document !== "undefined" && document.hidden) return;
      if (!inflight) void runLoad();
    }, WIDGET_REFRESH_MS);
  }

  function stopPollTimer() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function isStale() {
    return lastFetchedAt === 0 || Date.now() - lastFetchedAt >= WIDGET_REFRESH_MS;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    subscribers += 1;

    if (data === null && !hasLoaded) {
      void runLoad();
    } else if (isStale()) {
      void runLoad();
    }

    startPollTimer();

    return () => {
      listeners.delete(listener);
      subscribers -= 1;
      if (subscribers === 0) stopPollTimer();
    };
  }

  return function usePollingStore(): Snapshot<T> {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  };
}
