/**
 * ASP set membership probe proxy — wallet auth + rate limit (OVERLORD F-8/F-9).
 */
import { NextRequest, NextResponse } from "next/server";
import { aspBaseUrl, aspProxyHeaders, aspSetUpstreamUrl, callerHeader } from "@/lib/aspServerUrl";
import { gatePrivilegedProxy } from "@/lib/privilegedProxyGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function aspBase(req: NextRequest): string {
  return aspBaseUrl(req.nextUrl.searchParams.get("chainId"));
}

export async function GET(req: NextRequest) {
  const gate = await gatePrivilegedProxy(req, {
    bucket: "asp-set-member",
    max: Number(process.env.ASP_SET_MEMBER_RATE_MAX || "30"),
  });
  if (!gate.ok) return gate.response;

  const base = aspBase(req);
  if (!base) {
    return NextResponse.json({ error: "asp_unconfigured" }, { status: 503 });
  }
  const label = req.nextUrl.searchParams.get("label") || "";
  if (!label) {
    return NextResponse.json({ error: "label required" }, { status: 400 });
  }
  try {
    const upstreamUrl = aspSetUpstreamUrl(base, "member");
    const chainId = req.nextUrl.searchParams.get("chainId") || "";
    const upstream = await fetch(`${upstreamUrl}?label=${encodeURIComponent(label)}${chainId ? `&chainId=${encodeURIComponent(chainId)}` : ""}`, {
      headers: aspProxyHeaders(base, callerHeader(gate.wallet), req.nextUrl.searchParams.get("chainId")),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await upstream.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: "invalid_upstream_json" };
    }
    return NextResponse.json(data ?? {}, { status: upstream.status });
  } catch (e) {
    return NextResponse.json(
      { error: "asp_unreachable", message: e instanceof Error ? e.message : "fail" },
      { status: 503 },
    );
  }
}
