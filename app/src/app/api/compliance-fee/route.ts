/**
 * Server proxy: browser → /api/compliance-fee → siphon-asp /compliance-fee/*
 * Keeps ASP_SCREEN_TOKEN off the client.
 *
 * Auth: wallet signature; wallet query/body must match authenticated wallet.
 *
 * GET  /api/compliance-fee?wallet=0x...  → ASP GET /compliance-fee/check?wallet=
 * POST /api/compliance-fee               → ASP POST /compliance-fee/verify
 */
import { NextRequest, NextResponse } from "next/server";
import { aspBaseUrl, aspProxyHeaders } from "@/lib/aspServerUrl";
import { gatePrivilegedProxy, requireWalletMatch } from "@/lib/privilegedProxyGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function aspBase(chainId?: number | string | null): string {
  return aspBaseUrl(chainId);
}

export async function GET(req: NextRequest) {
  const gated = await gatePrivilegedProxy(req, {
    bucket: "compliance-fee",
    max: Number(process.env.COMPLIANCE_FEE_RATE_MAX || "30"),
  });
  if (!gated.ok) return gated.response;

  // The fee vault and its receipts are per chain; so is the ASP when the chain has its own.
  const base = aspBase(req.nextUrl.searchParams.get("chainId"));
  if (!base) {
    return NextResponse.json({ error: "asp_unconfigured" }, { status: 503 });
  }

  const wallet = req.nextUrl.searchParams.get("wallet") ?? "";
  if (!wallet) {
    return NextResponse.json({ error: "wallet query param required" }, { status: 400 });
  }
  const mismatch = requireWalletMatch(gated.wallet, wallet, "wallet");
  if (mismatch) return mismatch;

  // chainId selects which chain's vault the ASP answers with. The UI sends the user's fee to that
  // address, and the vaults are NOT the same on every chain — Sepolia's is a contract, and that
  // same address holds no code on Base. Forwarding the caller's chain is what keeps the quote and
  // the payment on the same chain.
  const chainId = (req.nextUrl.searchParams.get("chainId") || "").trim();
  const chainQuery = /^\d+$/.test(chainId) ? `&chainId=${chainId}` : "";
  const product = (req.nextUrl.searchParams.get("product") || "").trim();
  const productQuery =
    product === "kyt_year_v1" || product === "kyc_year_v1"
      ? `&product=${encodeURIComponent(product)}`
      : "";
  const upstream =
    `${base}/compliance-fee/check?wallet=${encodeURIComponent(wallet)}${chainQuery}${productQuery}`;
  try {
    const resp = await fetch(upstream, {
      headers: aspProxyHeaders(base, { "Content-Type": "application/json" }, req.nextUrl.searchParams.get("chainId")),
      cache: "no-store",
    });
    const data: unknown = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (err) {
    return NextResponse.json(
      { error: "asp_unreachable", message: String(err) },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest) {
  const gated = await gatePrivilegedProxy(req, {
    bucket: "compliance-fee",
    max: Number(process.env.COMPLIANCE_FEE_RATE_MAX || "30"),
  });
  if (!gated.ok) return gated.response;

  const base = aspBase();
  if (!base) {
    return NextResponse.json({ error: "asp_unconfigured" }, { status: 503 });
  }

  let body: { wallet?: string; txHash?: string; chainId?: number; product?: string };
  try {
    body = JSON.parse(gated.bodyText || "{}") as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const wallet = (body.wallet || "").trim();
  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 });
  }
  const mismatch = requireWalletMatch(gated.wallet, wallet, "wallet");
  if (mismatch) return mismatch;

  const chainBase = aspBase(body.chainId);
  const upstream = `${chainBase}/compliance-fee/verify`;
  try {
    const resp = await fetch(upstream, {
      method: "POST",
      headers: aspProxyHeaders(chainBase, { "Content-Type": "application/json" }, body.chainId),
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data: unknown = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (err) {
    return NextResponse.json(
      { error: "asp_unreachable", message: String(err) },
      { status: 503 },
    );
  }
}
