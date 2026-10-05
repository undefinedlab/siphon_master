/**
 * Per-IP rate limits for unauthenticated same-origin outbound proxies
 * (verify-quote, market feeds, etc.) — prevents quota burn on upstream APIs.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { clientKeyFromRequest, isRateLimited } from "@/lib/graphHttpGuard";

export function gateOutboundProxy(
  req: NextRequest,
  bucket: string,
  max = Number(process.env.OUTBOUND_PROXY_RATE_MAX || "60"),
): NextResponse | null {
  const ip = clientKeyFromRequest(req);
  if (isRateLimited(`outbound:${bucket}:${ip}`, max)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  return null;
}
