import { NextRequest, NextResponse } from "next/server";
import { CDN_CACHE } from "@/lib/cdnCache";
import { gateOutboundProxy } from "@/lib/outboundProxyGate";

export async function GET(req: NextRequest) {
  const limited = gateOutboundProxy(req, "market-global", Number(process.env.MARKET_GLOBAL_RATE_MAX || "30"));
  if (limited) return limited;

  try {
    const apiKey = process.env.COINGECKO_API_KEY;
    const response = await fetch("https://api.coingecko.com/api/v3/global", {
      headers: {
        Accept: "application/json",
        ...(apiKey ? { "x-cg-demo-api-key": apiKey } : {}),
      },
      next: { revalidate: 60 },
    });

    if (!response.ok) {
      throw new Error(`CoinGecko global API error: ${response.status}`);
    }

    const json = await response.json();
    const data = json.data;

    return NextResponse.json({
      global_cap_usd: data.total_market_cap?.usd ?? null,
      volume_24h_usd: data.total_volume?.usd ?? null,
      market_cap_change_24h_pct: data.market_cap_change_percentage_24h_usd ?? null,
      btc_dominance_pct: data.market_cap_percentage?.btc ?? null,
      eth_dominance_pct: data.market_cap_percentage?.eth ?? null,
    }, { headers: CDN_CACHE });
  } catch (error) {
    console.error("[API] market-global error:", error);
    return NextResponse.json(
      { error: "Failed to fetch global market data" },
      { status: 500 },
    );
  }
}
