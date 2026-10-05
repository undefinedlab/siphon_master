import { NextResponse } from "next/server";
import { createCspReportRateLimit, summarizeCspPayload } from "@/lib/cspReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rateLimit = createCspReportRateLimit();

/**
 * CSP Report-Only collector. Browsers POST here; we never block page loads.
 * Logs a compact summary for allowlist tuning — no storage, no user PII beyond what CSP sends.
 */
export async function POST(request: Request) {
  if (!rateLimit.allow()) {
    return new NextResponse(null, { status: 204 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  for (const s of summarizeCspPayload(payload)) {
    console.info("[csp-report]", JSON.stringify(s));
  }

  return new NextResponse(null, { status: 204 });
}

/** Some browsers probe with GET — stay quiet. */
export async function GET() {
  const { cspEnforceEnabled } = await import("@/lib/csp");
  return NextResponse.json({
    ok: true,
    mode: cspEnforceEnabled() ? "enforce+report" : "report-only",
  });
}
