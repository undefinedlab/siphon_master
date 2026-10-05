import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  applySecurityHeaders,
  getCrawlerBlockReason,
  ROBOTS_DIRECTIVES,
} from "./lib/botProtection";
import { isSameSiteHost, secFetchSiteAllows } from "./lib/sameSiteHost";

function blockedResponse(reason: string): NextResponse {
  return new NextResponse("Access denied.", {
    status: 403,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": ROBOTS_DIRECTIVES,
      "Cache-Control": "no-store",
      "X-Crawler-Block": reason,
    },
  });
}

function isProductionRuntime(): boolean {
  const v = (process.env.VERCEL_ENV || process.env.NODE_ENV || "").toLowerCase();
  return v === "production" || v === "prod";
}

/** API scrapers often omit Origin; require same-origin hint in production (UA checks alone are theater). */
function apiOriginForbidden(request: NextRequest, pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  // Browsers may POST CSP reports without a classic Origin in some modes — keep collector open.
  if (pathname === "/api/csp-report") return false;
  // TEE/executor → Next prove hop: Python requests has no Origin/Sec-Fetch-Site; the route
  // authorizes via X-Pipeline-Prove-Token (or mock-TEE allow).
  if (pathname === "/api/solana/pipeline-prove") return false;
  if (!isProductionRuntime()) return false;

  // Sec-Fetch-Site first: it is the only one of the three a browser always sends and a script
  // can never forge. Origin is absent on same-origin GET and Referer is stripped by our own
  // Referrer-Policy, so gating on those alone rejected every GET the dapp made.
  const bySecFetch = secFetchSiteAllows(request.headers.get("sec-fetch-site"));
  if (bySecFetch !== null) return !bySecFetch;

  const host = request.headers.get("host") || "";
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (!origin && !referer) return true;
  try {
    // apex vs www is the SAME site — siphon.money 308-redirects to www.siphon.money and the
    // browser carries the apex Origin across, so an exact compare 403s the whole dapp.
    if (origin && !isSameSiteHost(new URL(origin).host, host)) return true;
    if (!origin && referer && !isSameSiteHost(new URL(referer).host, host)) return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * /verify and /receipt are rewritten to the trade-executor. Block path traversal and
 * odd segments so the rewrite cannot be used as an open path oracle (PROXY-05).
 */
function unsafeExecutorProxyPath(pathname: string): boolean {
  if (!pathname.startsWith("/verify/") && !pathname.startsWith("/receipt/")) {
    return pathname === "/verify" || pathname === "/receipt";
  }
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  })();
  if (decoded.includes("..") || decoded.includes("\\") || decoded.includes("\0")) return true;
  // Allow /verify/<slug>, /receipt/<slug>, /receipt/verify, optional one nested segment.
  return !/^\/(verify|receipt)\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]*)?\/?$/.test(decoded);
}

export function middleware(request: NextRequest) {
  const userAgent = request.headers.get("user-agent");
  const pathname = request.nextUrl.pathname;

  // Server-to-server TEE prove (trade-executor → Next). Skip bot/origin gates; route auth
  // is X-Pipeline-Prove-Token / mock-TEE allow.
  if (pathname === "/api/solana/pipeline-prove") {
    return NextResponse.next();
  }

  const blockReason = getCrawlerBlockReason(userAgent, request.headers, pathname);
  if (blockReason) {
    return blockedResponse(blockReason);
  }

  if (apiOriginForbidden(request, pathname)) {
    return NextResponse.json({ error: "origin_required" }, { status: 403 });
  }

  if (unsafeExecutorProxyPath(pathname)) {
    return NextResponse.json({ error: "path_forbidden" }, { status: 400 });
  }

  // Public ceremony artifacts — do not force private no-store (breaks caching of large zkeys).
  if (pathname.startsWith("/zk/")) {
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  }

  // ponytail: env-var toggle needs a Vercel redeploy (~1 min); move to Edge Config if instant flips matter
  if (process.env.MAINTENANCE_MODE === "1" && pathname !== "/maintenance") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Siphon is under maintenance. Transactions are temporarily disabled." },
        { status: 503, headers: { "Retry-After": "3600" } }
      );
    }
    return NextResponse.rewrite(new URL("/maintenance", request.url));
  }

  const response = NextResponse.next();
  applySecurityHeaders(response.headers, request.nextUrl.origin);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|wasm)$).*)",
  ],
};
