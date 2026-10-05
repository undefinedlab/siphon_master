/**
 * Auth + rate-limit for /api/graph (vault-index assess proxy — keeps internal reads off the public internet).
 *
 * NOTE (M3): buckets are in-memory per serverless isolate — fine as a soft brake, not a
 * hard quota. Privileged routes also require wallet auth + same-origin so RL is secondary.
 * For durable limits, put a gateway/WAF in front or use shared KV.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

export function isProductionRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = (env.VERCEL_ENV || env.NODE_ENV || "").toLowerCase();
  return v === "production" || v === "prod";
}

export function clientKeyFromRequest(req: NextRequest): string {
  // Prefer platform-injected IPs. Leftmost X-Forwarded-For is client-spoofable when
  // the edge does not overwrite it — never use it as the sole trust source.
  const platform =
    req.headers.get("cf-connecting-ip")?.trim() ||
    req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim();
  if (platform) return platform;

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    // Rightmost hop is typically appended by the nearest trusted proxy.
    if (parts.length) return parts[parts.length - 1]!;
  }
  return "unknown";
}

export function isRateLimited(
  key: string,
  max = Number(process.env.GRAPH_HTTP_RATE_MAX || "30"),
  now = Date.now(),
  windowMs = RATE_WINDOW_MS,
): boolean {
  const prev = hits.get(key) || [];
  const recent = prev.filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

/** Test helper — clear in-memory buckets. */
export function resetGraphHttpRateLimit(): void {
  hits.clear();
}

export type GraphHttpAuthResult =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, string> };

/**
 * - GRAPH_HTTP_TOKEN set → require Bearer / X-Graph-Token / X-API-TOKEN
 * - Production → token required unless GRAPH_HTTP_PUBLIC=true
 * - Dev → open unless token is set
 */
export function authorizeGraphHttp(
  req: NextRequest,
  env: NodeJS.ProcessEnv = process.env,
): GraphHttpAuthResult {
  const required = (env.GRAPH_HTTP_TOKEN || "").trim();
  const allowPublic =
    (env.GRAPH_HTTP_PUBLIC || "").toLowerCase() === "true" ||
    env.GRAPH_HTTP_PUBLIC === "1";
  const prod = isProductionRuntime(env);

  if (!required && !prod) return { ok: true };
  if (!required && prod && allowPublic) return { ok: true };
  if (!required && prod) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "graph_http_locked",
        detail:
          "Set GRAPH_HTTP_TOKEN (or GRAPH_HTTP_PUBLIC=true for intentional open access)",
      },
    };
  }

  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const headerToken =
    bearer ||
    (req.headers.get("x-graph-token") || "").trim() ||
    (req.headers.get("x-api-token") || "").trim();

  if (!required || headerToken !== required) {
    return { ok: false, status: 401, body: { error: "unauthorized" } };
  }
  return { ok: true };
}

export function graphHttpAuthResponse(
  result: GraphHttpAuthResult,
): NextResponse | null {
  if (result.ok) return null;
  return NextResponse.json(result.body, { status: result.status });
}
