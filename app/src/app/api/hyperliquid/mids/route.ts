// Public Hyperliquid allMids proxy — mark prices for Private Perps UI (no auth).
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HL_INFO = process.env.HYPERLIQUID_API_URL?.replace(/\/$/, "") || "https://api.hyperliquid.xyz";

/** Curated coins shown on the Private Perps page. */
const FEATURED = ["BTC", "ETH", "SOL", "HYPE", "ARB", "DOGE"] as const;

export type HlMid = { coin: string; mid: number };

export async function GET() {
  try {
    const res = await fetch(`${HL_INFO}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      next: { revalidate: 15 },
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Hyperliquid HTTP ${res.status}` }, { status: 502 });
    }
    const data = (await res.json()) as Record<string, string>;
    const mids: HlMid[] = FEATURED.map((coin) => {
      const raw = data[coin];
      const mid = raw != null ? Number(raw) : NaN;
      return { coin, mid: Number.isFinite(mid) ? mid : 0 };
    }).filter((m) => m.mid > 0);

    return NextResponse.json(
      { mids },
      { headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load Hyperliquid mids" },
      { status: 502 },
    );
  }
}
