import { NextRequest, NextResponse } from "next/server";
import { CDN_CACHE } from "@/lib/cdnCache";
import { gateOutboundProxy } from "@/lib/outboundProxyGate";

const FNG_URL = "https://api.alternative.me/fng/?limit=1&format=json";

type AlternativeMeResponse = {
  data?: Array<{
    value?: string;
    value_classification?: string;
    timestamp?: string;
  }>;
};

export async function GET(req: NextRequest) {
  const limited = gateOutboundProxy(req, "fear-greed", Number(process.env.FEAR_GREED_RATE_MAX || "30"));
  if (limited) return limited;

  try {
    const response = await fetch(FNG_URL, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      throw new Error(`alternative.me FNG error: ${response.status}`);
    }

    const json = (await response.json()) as AlternativeMeResponse;
    const row = json.data?.[0];
    const value = Number(row?.value);
    const label = row?.value_classification?.trim();

    if (!Number.isFinite(value) || !label) {
      throw new Error("alternative.me FNG returned invalid payload");
    }

    const ts = row?.timestamp ? Number(row.timestamp) * 1000 : null;
    const updatedAt =
      ts != null && Number.isFinite(ts) ? new Date(ts).toISOString() : null;

    return NextResponse.json({
      value: Math.min(100, Math.max(0, Math.round(value))),
      label,
      updatedAt,
    }, { headers: CDN_CACHE });
  } catch (error) {
    console.error("[API] fear-greed error:", error);
    return NextResponse.json(
      { error: "Failed to fetch fear & greed index" },
      { status: 500 },
    );
  }
}
