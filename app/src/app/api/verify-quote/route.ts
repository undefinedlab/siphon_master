export const runtime = "nodejs";
// CORS proxy for DCAP quote verification: Phala's attestation API is server-to-server only
// (no Access-Control-Allow-Origin), so the browser calls this route instead. Pass-through —
// the verdict comes from the DCAP verifier; the browser still checks report_data binding and
// the RTMR3/compose-hash pin itself (see src/lib/decryptorAttestation.ts).

import { NextRequest, NextResponse } from "next/server";
import { gateOutboundProxy } from "@/lib/outboundProxyGate";

const QUOTE_VERIFY_URL =
  process.env.QUOTE_VERIFY_URL || "https://cloud-api.phala.network/api/v1/attestations/verify";

const QUOTE_RATE_MAX = Number(process.env.VERIFY_QUOTE_RATE_MAX || "20");

export async function POST(req: NextRequest) {
  const limited = gateOutboundProxy(req, "verify-quote", QUOTE_RATE_MAX);
  if (limited) return limited;
  let hex: unknown;
  try {
    ({ hex } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // A TDX quote is ~5-8KB; cap well above that but below abuse territory.
  if (typeof hex !== "string" || hex.length < 100 || hex.length > 100_000 || /[^0-9a-fA-Fx]/.test(hex)) {
    return NextResponse.json({ error: "body must be { hex: <TDX quote hex> }" }, { status: 400 });
  }
  try {
    const res = await fetch(QUOTE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hex }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({ error: "verifier returned non-JSON" }));
    return NextResponse.json(body, { status: res.status });
  } catch (e) {
    return NextResponse.json(
      { error: `quote verifier unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
