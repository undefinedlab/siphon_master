import { NextRequest, NextResponse } from "next/server";
import { CDN_CACHE } from "@/lib/cdnCache";
import { gateOutboundProxy } from "@/lib/outboundProxyGate";
import type { CoinItem } from "@/components/widgets/coins/types";

type CoinGeckoMarket = {
  id?: string;
  symbol?: string;
  name?: string;
  current_price?: number | null;
  price_change_percentage_1h_in_currency?: number | null;
  price_change_percentage_24h_in_currency?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
  total_volume?: number | null;
  market_cap?: number | null;
  market_cap_rank?: number | null;
  price_change_percentage_24h?: number | null;
};

function toCoinItem(row: CoinGeckoMarket): CoinItem | null {
  if (!row.id || !row.symbol || !row.name) return null;
  return {
    id: row.id,
    symbol: row.symbol.toUpperCase(),
    name: row.name,
    current_price: row.current_price ?? null,
    price_change_percentage_1h_in_currency: row.price_change_percentage_1h_in_currency ?? null,
    price_change_percentage_24h_in_currency: row.price_change_percentage_24h_in_currency ?? null,
    price_change_percentage_7d_in_currency: row.price_change_percentage_7d_in_currency ?? null,
    total_volume: row.total_volume ?? null,
    market_cap: row.market_cap ?? null,
    market_cap_rank: row.market_cap_rank ?? null,
    price_change_percentage_24h: row.price_change_percentage_24h ?? null,
  };
}

export async function GET(req: NextRequest) {
  const limited = gateOutboundProxy(req, "coins", Number(process.env.COINS_RATE_MAX || "30"));
  if (limited) return limited;

  try {
    const apiKey = process.env.COINGECKO_API_KEY;
    const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("order", "market_cap_desc");
    url.searchParams.set("per_page", "50");
    url.searchParams.set("page", "1");
    url.searchParams.set("sparkline", "false");
    url.searchParams.set("price_change_percentage", "1h,24h,7d");

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(apiKey ? { "x-cg-demo-api-key": apiKey } : {}),
      },
      next: { revalidate: 180 },
    });

    if (!response.ok) {
      throw new Error(`CoinGecko markets API error: ${response.status}`);
    }

    const json = (await response.json()) as CoinGeckoMarket[];
    const coins = json.map(toCoinItem).filter((c): c is CoinItem => c !== null);

    if (coins.length === 0) {
      throw new Error("CoinGecko markets returned no coins");
    }

    return NextResponse.json(coins, { headers: CDN_CACHE });
  } catch (error) {
    console.error("[API] coins error:", error);
    return NextResponse.json({ error: "Failed to fetch coin market data" }, { status: 500 });
  }
}
