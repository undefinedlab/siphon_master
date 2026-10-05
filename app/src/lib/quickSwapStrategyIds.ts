const STORAGE_KEY = "siphon.quickSwapStrategyIds";

function readSet(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const list = JSON.parse(raw) as string[];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function writeSet(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids].slice(-200)));
}

export function markQuickSwapStrategy(strategyId: string): void {
  if (!strategyId) return;
  const ids = readSet();
  ids.add(strategyId);
  writeSet(ids);
}

export function isQuickSwapStrategy(strategyId: string): boolean {
  return readSet().has(strategyId);
}
