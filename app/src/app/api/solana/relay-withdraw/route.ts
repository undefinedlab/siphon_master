/**
 * Browser → same origin → Solana trade executor `/solana/relayWithdraw`.
 *
 * The browser cannot call that host directly: its CORS preflight allows only
 * `content-type`, and the withdraw also sends the Phantom session headers, so
 * the browser rejects the request as "Failed to fetch" before it is sent.
 * The executor still checks the session. This route only forwards it.
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const EXECUTOR =
  process.env.NEXT_PUBLIC_SOLANA_DEVNET_EXECUTOR_URL ||
  "https://siphon-fhe-sol-production.up.railway.app";

export async function POST(req: NextRequest) {
  const address = req.headers.get("x-solana-address") || "";
  const session = req.headers.get("x-solana-session") || "";
  const expires = req.headers.get("x-solana-expires") || "";
  if (!address || !session || !expires) {
    return NextResponse.json({ error: "wallet_auth_required" }, { status: 401 });
  }
  let body = "";
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  try {
    const upstream = await fetch(`${EXECUTOR.replace(/\/+$/, "")}/solana/relayWithdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Solana-Address": address,
        "X-Solana-Session": session,
        "X-Solana-Expires": expires,
      },
      body,
      signal: AbortSignal.timeout(110_000),
    });
    const text = await upstream.text();
    return new NextResponse(text || "{}", {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "executor_unreachable", message: e instanceof Error ? e.message : "fail" },
      { status: 503 },
    );
  }
}
