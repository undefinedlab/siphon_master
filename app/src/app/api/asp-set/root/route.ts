/**
 * Server proxies for Hard ASP association-set reads (keeps ASP_SCREEN_TOKEN off the client).
 * Wallet-authenticated + rate-limited — root/path previously burned the screen token unauth.
 */
import { NextRequest, NextResponse } from "next/server";
import { aspBaseUrl, aspProxyHeaders, aspSetUpstreamUrl } from "@/lib/aspServerUrl";
import { gatePrivilegedProxy } from "@/lib/privilegedProxyGate";
import { verifyAspRootsCurrent } from "@/lib/aspRootFreshness";
import { solanaPublishCatchUp } from "@/lib/solanaRootPublish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function aspBase(req: NextRequest): string {
  return aspBaseUrl(req.nextUrl.searchParams.get("chainId"));
}

/** solasp `/set/root` already compares ASP ↔ compliance PDA; trust that when our RPC check flakes. */
function aspReportsOnchainMatch(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  const sync = d.onchainSync as { admittedMatch?: unknown; revokedMatch?: unknown } | undefined;
  if (sync?.admittedMatch === true && sync?.revokedMatch === true) return true;
  try {
    if (d.admittedRoot == null || d.onchainAdmittedRoot == null) return false;
    if (d.revokedRoot == null || d.onchainRevokedRoot == null) return false;
    return (
      BigInt(String(d.admittedRoot)) === BigInt(String(d.onchainAdmittedRoot)) &&
      BigInt(String(d.revokedRoot)) === BigInt(String(d.onchainRevokedRoot))
    );
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const gate = await gatePrivilegedProxy(req, {
    bucket: "asp-set-root",
    max: Number(process.env.ASP_SET_ROOT_RATE_MAX || "60"),
  });
  if (!gate.ok) return gate.response;

  const base = aspBase(req);
  if (!base) {
    return NextResponse.json({ error: "asp_unconfigured" }, { status: 503 });
  }
  try {
    const chainId = req.nextUrl.searchParams.get("chainId") || "";
    const upstreamUrl = aspSetUpstreamUrl(base, "root");
    const load = async (): Promise<{ status: number; data: unknown }> => {
      const upstream = await fetch(`${upstreamUrl}${chainId ? `?chainId=${encodeURIComponent(chainId)}` : ""}`, {
        headers: aspProxyHeaders(base, { "Content-Type": "application/json" }, req.nextUrl.searchParams.get("chainId")),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await upstream.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { error: "invalid_upstream_json" };
      }
      return { status: upstream.status, data };
    };
    let { status, data } = await load();
    if (status >= 200 && status < 300 && data && typeof data === "object") {
      const roots = data as { admittedRoot?: unknown; revokedRoot?: unknown };
      let caught = await solanaPublishCatchUp(chainId || null, roots);
      if (caught.action === "reload") {
        ({ status, data } = await load());
        if (status >= 200 && status < 300 && data && typeof data === "object") {
          const again = await verifyAspRootsCurrent(chainId || null, data as typeof roots);
          caught = again.ok ? { action: "serve" } : { action: "deny", error: again.error };
        }
      }
      if (caught.action === "deny") {
        // Local Solana RPC timeout used to 503 Discover even when solasp already reported a match
        // (and path/smt-path soft-fail). Serve the ASP snapshot in that case.
        if (aspReportsOnchainMatch(data)) {
          return NextResponse.json(data, { status });
        }
        return NextResponse.json({ error: caught.error }, { status: 503 });
      }
    }
    return NextResponse.json(data ?? {}, { status });
  } catch (e) {
    return NextResponse.json(
      { error: "asp_unreachable", message: e instanceof Error ? e.message : "fail" },
      { status: 503 },
    );
  }
}
