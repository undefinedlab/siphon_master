/**
 * TradingView free embed — dashboard chart tile.
 * @see https://www.tradingview.com/widget-docs/widgets/charts/advanced-chart/
 */

export const CHART_EMBED_STYLE = "1";
export const CHART_EMBED_THEME = "dark" as const;

/** TradingView interval codes — @see widget `interval` param */
export const CHART_INTERVALS = [
  { id: "1", label: "1m" },
  { id: "60", label: "1h" },
  { id: "D", label: "1d" },
  { id: "W", label: "1w" },
] as const;

export type ChartIntervalId = (typeof CHART_INTERVALS)[number]["id"];

export const CHART_EMBED_DEFAULT_INTERVAL: ChartIntervalId = "D";

export type ChartEmbedParams = {
  autosize: boolean;
  symbol: string;
  interval: string;
  timezone: string;
  theme: "dark" | "light";
  style: string;
  locale: string;
  enable_publishing: boolean;
  allow_symbol_change: boolean;
  hide_top_toolbar: boolean;
  hide_side_toolbar: boolean;
  hide_legend: boolean;
  withdateranges: boolean;
  save_image: boolean;
  calendar: boolean;
  support_host: string;
};

export function buildTradingViewEmbedSrc(
  symbol: string,
  interval: ChartIntervalId = CHART_EMBED_DEFAULT_INTERVAL,
): string {
  const params: ChartEmbedParams = {
    autosize: true,
    symbol,
    interval,
    timezone: "Etc/UTC",
    theme: CHART_EMBED_THEME,
    style: CHART_EMBED_STYLE,
    locale: "en",
    enable_publishing: false,
    allow_symbol_change: false,
    hide_top_toolbar: true,
    hide_side_toolbar: true,
    hide_legend: true,
    withdateranges: false,
    save_image: false,
    calendar: false,
    support_host: "https://www.tradingview.com",
  };
  return `https://s.tradingview.com/embed-widget/advanced-chart/?locale=en#${encodeURIComponent(JSON.stringify(params))}`;
}
