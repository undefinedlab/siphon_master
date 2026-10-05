export type AspSetEndpoint = "path" | "root" | "smt-path" | "member";

function clean(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Chains with their OWN ASP deployment. Literal reads (never `process.env[computed]`, which
 * assert-env-inlinable rejects); add a chain by adding a row and the names to amplify.yml.
 */
function ownAsp(chainId?: number | string | null): { url: string; screen: string; postman: string } | null {
  switch (String(chainId ?? "").trim()) {
    case "42161":
      return {
        url: process.env.ASP_URL_42161 || "",
        screen: process.env.ASP_SCREEN_TOKEN_42161 || "",
        postman: process.env.ASP_POSTMAN_TOKEN_42161 || "",
      };
    // Sepolia v5 — its own ASP on the Arbitrum box (https://api.siphon.money/asp-sepolia).
    case "11155111":
      return {
        url: process.env.ASP_URL_11155111 || "",
        screen: process.env.ASP_SCREEN_TOKEN_11155111 || "",
        postman: process.env.ASP_POSTMAN_TOKEN_11155111 || "",
      };
    case "42431":
      return {
        url: process.env.ASP_URL_42431 || "",
        screen: process.env.ASP_SCREEN_TOKEN_42431 || "",
        postman: process.env.ASP_POSTMAN_TOKEN_42431 || "",
      };
    case "998":
      return {
        url: process.env.ASP_URL_998 || "",
        screen: process.env.ASP_SCREEN_TOKEN_998 || "",
        postman: process.env.ASP_POSTMAN_TOKEN_998 || "",
      };
    // Solana Devnet ZK vault — siphon-solasp on the AWS box (https://api.siphon.money/solasp).
    case "900002":
      return {
        url: process.env.ASP_URL_900002 || "",
        screen: process.env.ASP_SCREEN_TOKEN_900002 || "",
        postman: process.env.ASP_POSTMAN_TOKEN_900002 || "",
      };
    default:
      return null;
  }
}

/** The chain's own ASP origin (`ASP_URL_<chainId>`), or "" when the chain uses the global ASP. */
function scopedAspUrl(chainId?: number | string | null): string {
  return clean(ownAsp(chainId)?.url || "");
}

/**
 * ASP origin for `chainId`. A chain with its own ASP deployment (Arbitrum's runs on a separate host
 * with its own database, postman and hub) sets `ASP_URL_<chainId>`; the rest use the global one.
 */
export function aspBaseUrl(chainId?: number | string | null): string {
  return scopedAspUrl(chainId) || clean(process.env.ASP_URL || process.env.ASP_HTTP_URL || "");
}

/**
 * Token for `chainId`'s ASP. A chain with its own ASP takes ONLY its own token — falling back to the
 * global one would hand Base's ASP credential to a different host. Empty means "not configured".
 */
function aspToken(name: "ASP_SCREEN_TOKEN" | "ASP_POSTMAN_TOKEN", chainId?: number | string | null): string {
  const own = ownAsp(chainId);
  if (own && clean(own.url)) return (name === "ASP_SCREEN_TOKEN" ? own.screen : own.postman).trim();
  return (
    (name === "ASP_SCREEN_TOKEN" ? process.env.ASP_SCREEN_TOKEN : process.env.ASP_POSTMAN_TOKEN) || ""
  ).trim();
}

export function aspPostmanToken(chainId?: number | string | null): string {
  return aspToken("ASP_POSTMAN_TOKEN", chainId);
}

/** Hosted Next `/api/asp-*` proxies 403 non-browser UAs; they already hold the screen token. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function viaHostedAspProxy(configuredUrl: string): boolean {
  return /\/api\/asp-(screen|set)(\/|$)/i.test(clean(configuredUrl));
}

/**
 * Identify the authenticated caller to the ASP.
 *
 * The ASP sees only this server's IP, so its per-client rate limit was really a global cap shared
 * by every user. It buckets on this header when present, falling back to IP. Safe to trust there
 * because those routes sit behind the screen token, which authenticates this proxy — a browser
 * cannot reach the ASP to forge one. `optional` is the unauthenticated sentinel from the gate and
 * must not become a bucket, or every anonymous caller would share one.
 */
export function callerHeader(wallet?: string): Record<string, string> {
  const w = (wallet || "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(w) ? { "X-Siphon-Caller": w } : {};
}

export function aspProxyHeaders(
  configuredUrl: string,
  extra?: Record<string, string>,
  chainId?: number | string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    ...extra,
  };
  const token = aspToken("ASP_SCREEN_TOKEN", chainId);
  if (token && !viaHostedAspProxy(configuredUrl)) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Resolve either a direct ASP origin or the hosted Next proxy used in production. */
export function aspScreenUpstreamUrl(configuredUrl: string): string {
  const url = clean(configuredUrl);
  if (/\/(screen|asp-screen)$/i.test(url)) return url;
  return `${url}/screen`;
}

export function aspSetUpstreamUrl(configuredUrl: string, endpoint: AspSetEndpoint): string {
  const url = clean(configuredUrl);
  if (/\/api\/asp-screen$/i.test(url)) {
    return url.replace(/\/api\/asp-screen$/i, `/api/asp-set/${endpoint}`);
  }
  if (/\/screen$/i.test(url)) {
    return url.replace(/\/screen$/i, `/set/${endpoint}`);
  }
  return `${url}/set/${endpoint}`;
}

/** Postman-only ASP mutations — never expose token to the browser. */
export function aspPostmanUpstreamUrl(configuredUrl: string, action: "admit" | "child" | "revoke"): string {
  const url = clean(configuredUrl);
  if (/\/api\/asp-screen$/i.test(url)) {
    return url.replace(/\/api\/asp-screen$/i, `/set/${action}`);
  }
  if (/\/screen$/i.test(url)) {
    return url.replace(/\/screen$/i, `/set/${action}`);
  }
  return `${url}/set/${action}`;
}

export function aspPostmanProxyHeaders(
  extra?: Record<string, string>,
  chainId?: number | string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    "Content-Type": "application/json",
    ...extra,
  };
  const token = aspPostmanToken(chainId);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    // The production Caddy path does not preserve Authorization for this upstream, while the ASP
    // explicitly supports its scoped postman header. Send both so direct and proxied deployments
    // authenticate without ever exposing the token to the browser.
    headers["X-Asp-Postman-Token"] = token;
  }
  return headers;
}
