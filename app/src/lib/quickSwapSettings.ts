const SLIPPAGE_STORAGE_KEY = "siphon.quickSwapSlippagePct";
export const DEFAULT_SWAP_SLIPPAGE_PCT = 3;
export const QUICK_SWAP_RUN_DURATION = "1h";

export function readSwapSlippagePct(): number {
  if (typeof window === "undefined") return DEFAULT_SWAP_SLIPPAGE_PCT;
  try {
    const raw = localStorage.getItem(SLIPPAGE_STORAGE_KEY);
    if (!raw) return DEFAULT_SWAP_SLIPPAGE_PCT;
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n < 0.01 || n > 50) return DEFAULT_SWAP_SLIPPAGE_PCT;
    return n;
  } catch {
    return DEFAULT_SWAP_SLIPPAGE_PCT;
  }
}

export function writeSwapSlippagePct(pct: number): void {
  if (typeof window === "undefined") return;
  const clamped = Math.min(50, Math.max(0.01, pct));
  localStorage.setItem(SLIPPAGE_STORAGE_KEY, String(clamped));
}

export function slippagePctToBps(pct: number): number {
  return Math.round(Math.max(0, pct) * 100);
}
