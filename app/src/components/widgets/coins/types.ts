export type CoinItem = {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  price_change_percentage_1h_in_currency: number | null;
  price_change_percentage_24h_in_currency: number | null;
  price_change_percentage_7d_in_currency: number | null;
  total_volume: number | null;
  market_cap: number | null;
  market_cap_rank: number | null;
  price_change_percentage_24h: number | null;
};

export type CoinView = "marketcap" | "trending" | "movers";
