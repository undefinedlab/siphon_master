/**
 * ASP set path proxy — wallet auth + rate limit; always HTTP 200 with found flag
 * (no status oracle). Membership remains discoverable via `found` (labels also
 * public on LabelMinted) but anonymous token-burn is closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { aspBaseUrl, aspProxyHeaders, aspSetUpstreamUrl, callerHeader } from "@/lib/aspServerUrl";
import { gatePrivilegedProxy } from "@/lib/privilegedProxyGate";
import { verifyAspRootsCurrent } from "@/lib/aspRootFreshness";
import { solanaPublishCatchUp } from "@/lib/solanaRootPublish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Publish + confirm can take most of a minute on Devnet before the path is servable. */
export const maxDuration = 120;

function aspBase(req: NextRequest): string {
  return aspBaseUrl(req.nextUrl.searchParams.get("chainId"));
}

export async function GET(req: NextRequest) {
  // OMEGA-06: tighter default — membership probes are path-bound but still enumerable.
  const gate = await gatePrivilegedProxy(req, {
    bucket: "asp-set-path",
    max: Number(process.env.ASP_SET_PATH_RATE_MAX || "20"),
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
    const upstreamUrl = aspSetUpstreamUrl(base, "path");
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
    // Pad membership: always 200 to the browser; client checks `found`.
    const missing = () => status === 404 || data.found === false;
    const upstreamError = () =>
      NextResponse.json(
        { error: typeof data.error === "string" ? data.error : "asp_upstream", found: false },
        { status: 200 },
      );
    if (missing()) return NextResponse.json({ found: false }, { status: 200 });
    if (status < 200 || status >= 300) return upstreamError();

    // Solana: the path is real, but the compliance PDA may still be on the previous root.
    // Publish that root (the postman key lives on solasp) and serve this path once it matches.
    let caught = await solanaPublishCatchUp(chainId || null, { admittedRoot: data.admittedRoot });
    if (caught.action === "reload") {
      ({ status, data } = await load());
      if (missing()) return NextResponse.json({ found: false }, { status: 200 });
      if (status < 200 || status >= 300) return upstreamError();
      const again = await verifyAspRootsCurrent(chainId || null, { admittedRoot: data.admittedRoot });
      caught = again.ok ? { action: "serve" } : { action: "deny", error: again.error };
    }
    if (caught.action === "deny") {
      return NextResponse.json({ error: caught.error, found: false }, { status: 200 });
    }
    return NextResponse.json({ ...data, found: data.found !== false }, { status: 200 });
  } catch (e) {
    return NextResponse.json(
      { error: "asp_unreachable", message: e instanceof Error ? e.message : "fail", found: false },
      { status: 503 },
    );
  }
}
