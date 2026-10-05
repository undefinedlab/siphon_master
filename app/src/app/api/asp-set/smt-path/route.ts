/**
 * ASP set SMT non-inclusion path proxy — wallet auth + rate limit.
 * Keeps ASP_SCREEN_TOKEN server-side (OVERLORD F-9).
 */
import { NextRequest, NextResponse } from "next/server";
import { aspBaseUrl, aspProxyHeaders, aspSetUpstreamUrl, callerHeader } from "@/lib/aspServerUrl";
import { gatePrivilegedProxy } from "@/lib/privilegedProxyGate";
import { verifyAspRootsCurrent } from "@/lib/aspRootFreshness";
import { solanaPublishCatchUp } from "@/lib/solanaRootPublish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function aspBase(req: NextRequest): string {
  return aspBaseUrl(req.nextUrl.searchParams.get("chainId"));
}

export async function GET(req: NextRequest) {
  const gate = await gatePrivilegedProxy(req, {
    bucket: "asp-set-smt-path",
    max: Number(process.env.ASP_SET_SMT_PATH_RATE_MAX || "20"),
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
    const upstreamUrl = aspSetUpstreamUrl(base, "smt-path");
    const chainId = req.nextUrl.searchParams.get("chainId") || "";
    const load = async (): Promise<{ status: number; data: Record<string, unknown> }> => {
      const upstream = await fetch(`${upstreamUrl}?label=${encodeURIComponent(label)}${chainId ? `&chainId=${encodeURIComponent(chainId)}` : ""}`, {
        headers: aspProxyHeaders(base, callerHeader(gate.wallet), req.nextUrl.searchParams.get("chainId")),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await upstream.text();
      let data: Record<string, unknown> = {};
      try {
        data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        data = { error: "invalid_upstream_json" };
      }
      return { status: upstream.status, data };
    };
    let { status, data } = await load();
    if (status < 200 || status >= 300) {
      return NextResponse.json(data, { status });
    }
    let caught = await solanaPublishCatchUp(chainId || null, { revokedRoot: data.revokedRoot });
    if (caught.action === "reload") {
      ({ status, data } = await load());
      if (status < 200 || status >= 300) return NextResponse.json(data, { status });
      const again = await verifyAspRootsCurrent(chainId || null, { revokedRoot: data.revokedRoot });
      caught = again.ok ? { action: "serve" } : { action: "deny", error: again.error };
    }
    if (caught.action === "deny") {
      return NextResponse.json({ error: caught.error }, { status: 503 });
    }
    return NextResponse.json(data, { status: 200 });
  } catch (e) {
    return NextResponse.json(
      { error: "asp_unreachable", message: e instanceof Error ? e.message : "fail" },
      { status: 503 },
    );
  }
}
