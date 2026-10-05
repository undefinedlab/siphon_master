"use client";

import { useEffect, type ReactNode } from "react";
import { retainEthPricePolling } from "./ethPriceStore";

export function EthPriceProvider({ children }: { children: ReactNode }) {
  useEffect(() => retainEthPricePolling(), []);
  return children;
}
