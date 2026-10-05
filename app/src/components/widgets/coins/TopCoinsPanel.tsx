"use client";

import { useState } from "react";
import { Sparkline } from "@/components/widgets/primitives/Sparkline";
import { formatCap, formatPct, formatPrice, sortCoins } from "./format";
import type { CoinView } from "./types";
import { useCoins } from "./useCoins";

const VIEW_TABS: { id: CoinView; label: string }[] = [
  { id: "marketcap", label: "Market cap" },
  { id: "trending", label: "Trending" },
  { id: "movers", label: "24h movers" },
];

const ROW_LIMIT = 5;

export function TopCoinsPanel({ sectionId }: { sectionId?: string }) {
  const [view, setView] = useState<CoinView>("marketcap");
  const rowLimit = ROW_LIMIT;
  const { data: coins, loading } = useCoins();
  const rows = coins ? sortCoins(coins, view).slice(0, rowLimit) : [];

  return (
    <div
      {...(sectionId ? { id: sectionId } : {})}
      className="widget-hover widget-card widget-card--coins"
    >
      <div className="widget-card-header">
        <div>
          <p className="widget-card-title">Coins</p>
          <p className="widget-card-subtitle">Top {rowLimit} — switch view</p>
        </div>
        <div className="widget-tabs" role="tablist">
          {VIEW_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={view === t.id}
              onClick={() => setView(t.id)}
              className={`widget-tab ${view === t.id ? "widget-tab--active" : ""}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="widget-table-wrap scrollbar-hide">
        <table className="widget-table min-w-0 w-full md:min-w-[640px]">
          <thead>
            <tr>
              <th className="hidden md:table-cell">#</th>
              <th>Asset</th>
              <th className="text-right">Price</th>
              <th className="hidden text-right md:table-cell">1h</th>
              <th className="text-right">24h</th>
              <th className="hidden text-right md:table-cell">7d</th>
              <th className="hidden text-right lg:table-cell">24h vol</th>
              <th className="hidden text-right xl:table-cell">MCap</th>
              <th className="hidden text-right md:table-cell">Trend</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-8 text-center text-xs text-[var(--defi-text-subtle)]">
                  Loading market data…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-8 text-center text-xs text-[var(--defi-text-subtle)]">
                  No coin data available.
                </td>
              </tr>
            ) : (
              rows.map((coin, i) => (
                <tr key={coin.id}>
                  <td className="hidden md:table-cell text-[var(--defi-text-subtle)]">
                    {view === "marketcap" ? (coin.market_cap_rank ?? i + 1) : i + 1}
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="widget-asset-avatar">
                        {coin.symbol.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <div className="widget-coins-name font-semibold text-[var(--defi-text)]">{coin.name}</div>
                        <div className="widget-coins-symbol uppercase text-[var(--defi-text-subtle)]">
                          {coin.symbol}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="widget-coins-price text-right font-medium tabular-nums text-[var(--defi-text)]">
                    {formatPrice(coin.current_price)}
                  </td>
                  <td
                    className={`hidden text-right tabular-nums md:table-cell widget-coins-change ${(coin.price_change_percentage_1h_in_currency ?? 0) >= 0 ? "text-[var(--defi-text)]" : "text-[var(--defi-text-muted)]"}`}
                  >
                    {formatPct(coin.price_change_percentage_1h_in_currency)}
                  </td>
                  <td
                    className={`widget-coins-change text-right tabular-nums ${(coin.price_change_percentage_24h_in_currency ?? 0) >= 0 ? "text-[var(--defi-text)]" : "text-[var(--defi-text-muted)]"}`}
                  >
                    {formatPct(coin.price_change_percentage_24h_in_currency)}
                  </td>
                  <td
                    className={`hidden text-right tabular-nums md:table-cell ${(coin.price_change_percentage_7d_in_currency ?? 0) >= 0 ? "text-[var(--defi-text)]" : "text-[var(--defi-text-muted)]"}`}
                  >
                    {formatPct(coin.price_change_percentage_7d_in_currency)}
                  </td>
                  <td className="hidden text-right text-[var(--defi-text-muted)] lg:table-cell">
                    {formatCap(coin.total_volume)}
                  </td>
                  <td className="hidden text-right text-[var(--defi-text-muted)] xl:table-cell">
                    {formatCap(coin.market_cap)}
                  </td>
                  <td className="hidden text-right md:table-cell">
                    <Sparkline
                      up={(coin.price_change_percentage_7d_in_currency ?? 0) >= 0}
                      className="ml-auto"
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
