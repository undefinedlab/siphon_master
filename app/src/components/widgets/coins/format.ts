import type { CoinItem, CoinView } from "./types";

export function formatPct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function formatPrice(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(6)}`;
}

export function formatCap(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  return `$${(n / 1e6).toFixed(0)}M`;
}

export function sortCoins(coins: CoinItem[], view: CoinView): CoinItem[] {
  const c = [...coins];
  if (view === "marketcap") {
    return c.sort((a, b) => (a.market_cap_rank ?? 999) - (b.market_cap_rank ?? 999));
  }
  if (view === "movers") {
    return c.sort(
      (a, b) =>
        Math.abs(b.price_change_percentage_24h_in_currency ?? b.price_change_percentage_24h ?? 0) -
        Math.abs(a.price_change_percentage_24h_in_currency ?? a.price_change_percentage_24h ?? 0),
    );
  }
  return c.sort(
    (a, b) =>
      (b.price_change_percentage_7d_in_currency ?? -Infinity) -
      (a.price_change_percentage_7d_in_currency ?? -Infinity),
  );
}
