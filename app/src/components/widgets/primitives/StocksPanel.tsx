"use client";

import { useState } from "react";
import { useLiveWidget } from "@/lib/useLiveWidget";
import { mockStocks, top4StockMovers, top4StocksByCap, top4TechStocks } from "@/data/mock-stocks";
import { Sparkline } from "@/components/widgets/primitives/Sparkline";

type StockView = "largecap" | "movers" | "tech";

const VIEW_TABS: { id: StockView; label: string }[] = [
  { id: "largecap", label: "Large cap" },
  { id: "movers", label: "Movers" },
  { id: "tech", label: "Tech" },
];

type LiveStockQuote = {
  ticker: string;
  price: number | null;
  change_pct: number | null;
  volume?: number | null;
};

type LiveStocksData = {
  quotes: LiveStockQuote[];
  provider: string;
  fetched_at: string;
};

const TECH_TICKERS = new Set(["NVDA", "MSFT", "META", "AAPL", "GOOGL", "AMZN"]);

function sortStocks(quotes: LiveStockQuote[], view: StockView): LiveStockQuote[] {
  const q = [...quotes];
  if (view === "movers") return q.sort((a, b) => Math.abs(b.change_pct ?? 0) - Math.abs(a.change_pct ?? 0));
  if (view === "tech") return q.filter((s) => TECH_TICKERS.has(s.ticker));
  return q; // largecap — keep original order
}

function formatPct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function StocksPanel({ sectionId }: { sectionId?: string }) {
  const [view, setView] = useState<StockView>("largecap");
  const live = useLiveWidget<LiveStocksData | null>("stocks", null, 30_000);

  const showLive = live !== null && live.quotes.length > 0;
  const liveRows = showLive ? sortStocks(live.quotes, view).slice(0, 4) : null;
  const mockRows =
    view === "largecap" ? top4StocksByCap(mockStocks) :
    view === "movers" ? top4StockMovers(mockStocks) :
    top4TechStocks(mockStocks);

  return (
    <div
      {...(sectionId ? { id: sectionId } : {})}
      className="widget-hover widget-card"
    >
      <div className="widget-card-header">
        <div>
          <p className="widget-card-title">Stocks</p>
          <p className="widget-card-subtitle">
            Top 4 — US equities{showLive ? ` · ${live!.provider}` : ""}
          </p>
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
        <table className="widget-table min-w-[320px]">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Price</th>
              <th className="text-right">Day</th>
              <th className="text-right">Trend</th>
            </tr>
          </thead>
          <tbody>
            {liveRows
              ? liveRows.map((row) => (
                  <tr key={`${view}-${row.ticker}`}>
                    <td className="font-semibold text-[var(--defi-text)]">{row.ticker}</td>
                    <td className="font-medium tabular-nums text-[var(--defi-text)]">
                      {row.price != null ? `$${row.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
                    </td>
                    <td className={`text-right tabular-nums ${(row.change_pct ?? 0) >= 0 ? "text-[var(--defi-text)]" : "text-[var(--defi-text-muted)]"}`}>
                      {formatPct(row.change_pct)}
                    </td>
                    <td className="text-right">
                      <Sparkline up={(row.change_pct ?? 0) >= 0} className="ml-auto" />
                    </td>
                  </tr>
                ))
              : mockRows.map((row) => (
                  <tr key={`${view}-${row.symbol}`}>
                    <td className="font-semibold text-[var(--defi-text)]">{row.symbol}</td>
                    <td className="font-medium tabular-nums text-[var(--defi-text)]">${row.price}</td>
                    <td className={`text-right tabular-nums ${row.changeDay >= 0 ? "text-[var(--defi-text)]" : "text-[var(--defi-text-muted)]"}`}>
                      {formatPct(row.changeDay)}
                    </td>
                    <td className="text-right">
                      <Sparkline up={row.sparkUp} className="ml-auto" />
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
