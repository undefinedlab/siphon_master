/**
 * Solana ZK vault state-tree leaves — browser → /api/solana/leaves → siphon-solasp
 * GET /solana/state/leaves.
 *
 * Deliberately does NOT import solanaVaultZk / snarkjs: those packages are browser-proving
 * deps and are often missing from the standalone server image. Leaves are public commitments
 * from ASP Postgres (already verified against the on-chain root by solasp).
 */
import { NextRequest, NextResponse } from "next/server";
import { assertBrowserSameOrigin } from "@/lib/apiWalletAuth";
import { aspBaseUrl, aspProxyHeaders } from "@/lib/aspServerUrl";
import { clientKeyFromRequest, isRateLimited } from "@/lib/graphHttpGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOLANA_ZK_CHAIN_ID = 900002;

export async function GET(req: NextRequest) {
  const originDeny = assertBrowserSameOrigin(req);
  if (originDeny) return NextResponse.json(originDeny.body, { status: originDeny.status });
  if (isRateLimited(`solana-leaves:${clientKeyFromRequest(req)}`, Number(process.env.SOLANA_LEAVES_RATE_MAX || "30"))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const base = aspBaseUrl(SOLANA_ZK_CHAIN_ID);
  if (!base) return NextResponse.json({ error: "asp_unconfigured" }, { status: 503 });
  try {
    const upstream = await fetch(`${base}/solana/state/leaves?chainId=${SOLANA_ZK_CHAIN_ID}`, {
      headers: aspProxyHeaders(base, {}, SOLANA_ZK_CHAIN_ID),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await upstream.json().catch(() => ({ error: "invalid_upstream_json" }));
    return NextResponse.json(data, { status: upstream.status });
  } catch (e) {
    return NextResponse.json(
      { error: "asp_unreachable", message: e instanceof Error ? e.message : "fail" },
      { status: 503 },
    );
  }
}
