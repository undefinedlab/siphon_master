"use client";

import { useSyncExternalStore } from "react";
import { getEthPriceSnapshot, subscribeEthPrice, retainEthPricePolling } from "./ethPriceStore";
import { useEffect } from "react";

export function useEthPrice(): number | null {
  useEffect(() => retainEthPricePolling(), []);

  return useSyncExternalStore(
    subscribeEthPrice,
    () => getEthPriceSnapshot().ethUsd,
    () => null
  );
}

export function useEthPriceUpdatedAt(): number | null {
  useEffect(() => retainEthPricePolling(), []);

  return useSyncExternalStore(
    subscribeEthPrice,
    () => getEthPriceSnapshot().updatedAt,
    () => null
  );
}
