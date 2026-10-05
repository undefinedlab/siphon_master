/**
 * Server-side verification of browser wallet auth headers.
 *
 * Unbound (legacy reads / executor-style):
 *   `Siphon auth v1:<ts>` via X-Wallet-Address / X-Signature / X-Timestamp
 *
 * Privileged Next proxies (OMEGA-01):
 *   `Siphon auth v1:req:<METHOD>:<path?query>:<bodySha256>:<ts>`
 *   Stolen blobs cannot be replayed against a different method, path, or body.
 *
 * Threat model notes:
 * - Unbound messages remain replayable until TTL — never use for prove/ASP/builder.
 * - API_WALLET_AUTH_OPTIONAL is ignored in production (AUTH-02).
 * - Origin checks are spoofable; real auth is the wallet signature (AUTH-03).
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { verifyMessage } from "ethers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isSameSiteHost, secFetchSiteAllows } from "./sameSiteHost";
import { SESSION_HEADER, verifyDelegation } from "./sessionKey";

/** Hosts this app is served on through a proxy (window.location.host values). */
const PUBLIC_APP_HOSTS = ["www.siphon.money", "siphon.money"] as const;

/** Must stay in sync with walletAuthHeaders.ts */
export const WALLET_AUTH_MESSAGE_PREFIX = "Siphon auth v1";

/** Privileged request-bound prefix — must stay in sync with walletAuthHeaders.ts */
export const PRIVILEGED_REQ_PREFIX = "Siphon auth v1:req";

/**
 * Soft privileged session — one sign covers one allowlisted route for a short TTL.
 * Message: `Siphon auth v1:session:<pathname>:<ts>`. Never accepted for prove (witnesses).
 */
export const PRIVILEGED_SESSION_PREFIX = "Siphon auth v1:session";

/**
 * Body-hash sentinel for path-scoped privileged auth (any body on that method+path).
 * Only accepted for routes in PRIVILEGED_PATH_SCOPE_ALLOWLIST — never for prove/ASP admit.
 */
export const PRIVILEGED_PATH_SCOPE_BODY = "*";

/**
 * Routes that accept a privileged *session* (method-agnostic soft gate).
 * Cost/abuse risk only — not witness or deposit-admit material.
 */
const PRIVILEGED_SESSION_ALLOWLIST = new Set<string>([
  "/api/builder-agent",
  "/api/asp-set/root",
  "/api/asp-set/path",
  "/api/asp-set/smt-path",
  "/api/asp-set/member",
  "/api/asp-screen",
  "/api/solana/admit-deposit",
  "/api/compliance-fee",
  "/api/zkme/token",
]);

/**
 * Routes where UX needs many POSTs with changing bodies; still method+path bound via `*`.
 * Prefer session when available; path-scope remains as fallback.
 */
const PRIVILEGED_PATH_SCOPE_ALLOWLIST = new Set<string>([
  "/api/builder-agent",
]);

export function privilegedPathAllowsSession(pathWithQuery: string): boolean {
  const path = pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`;
  const pathname = path.split("?")[0] || path;
  return PRIVILEGED_SESSION_ALLOWLIST.has(pathname);
}

export function privilegedPathAllowsScope(pathWithQuery: string): boolean {
  const path = pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`;
  const pathname = path.split("?")[0] || path;
  return PRIVILEGED_PATH_SCOPE_ALLOWLIST.has(pathname);
}

export function buildPrivilegedSessionMessage(timestamp: string, pathname: string): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const bare = path.split("?")[0] || path;
  return `${PRIVILEGED_SESSION_PREFIX}:${bare}:${timestamp}`;
}

/**
 * Default for non-privileged / executor-style reads.
 * Shorter than the historical 7d so stolen blobs expire sooner; override via env.
 */
const DEFAULT_MAX_AGE_SEC = 24 * 60 * 60;

/**
 * Privileged request-bound TTL. Binding already limits replay to identical
 * method/path/body; keep window short for GET empty-body paths.
 */
const DEFAULT_PRIVILEGED_MAX_AGE_SEC = 5 * 60;

export type WalletAuthOk = { ok: true; wallet: string };
export type WalletAuthFail = {
  ok: false;
  status: number;
  body: Record<string, string>;
};
export type WalletAuthResult = WalletAuthOk | WalletAuthFail;

export type VerifyWalletAuthOptions = {
  /** Override max age in seconds (privileged routes pass privilegedWalletAuthMaxAgeSec). */
  maxAgeSec?: number;
};

export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.VERCEL_ENV || env.SIPHON_ENV || env.NODE_ENV || "").trim().toLowerCase();
  return v === "production" || v === "prod";
}

export function walletAuthMaxAgeSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw =
    env.WALLET_AUTH_MAX_AGE_SEC ||
    env.NEXT_PUBLIC_WALLET_AUTH_MAX_AGE_SEC ||
    "";
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_MAX_AGE_SEC;
}

/** Short TTL for routes that hold server secrets or forward private witnesses. */
export function privilegedWalletAuthMaxAgeSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRIVILEGED_WALLET_AUTH_MAX_AGE_SEC || "";
  const n = Number(raw);
  const general = walletAuthMaxAgeSec(env);
  if (Number.isFinite(n) && n > 0) {
    // Never allow privileged TTL to exceed the general max (misconfig safety).
    return Math.min(Math.floor(n), general);
  }
  return Math.min(DEFAULT_PRIVILEGED_MAX_AGE_SEC, general);
}

/**
 * When false: wallet auth required (default).
 * Set API_WALLET_AUTH_OPTIONAL=1 only for emergency break-glass on non-production.
 * In production the flag is ignored and auth stays required (AUTH-02).
 */
export function walletAuthRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const optional =
    (env.API_WALLET_AUTH_OPTIONAL || "").trim().toLowerCase() === "1" ||
    (env.API_WALLET_AUTH_OPTIONAL || "").trim().toLowerCase() === "true";
  if (!optional) return true;
  if (isProductionRuntime(env)) {
    console.error(
      "[security] API_WALLET_AUTH_OPTIONAL is set but ignored in production — wallet auth remains required",
    );
    return true;
  }
  return false;
}

/** Hex sha256 of UTF-8 body (empty string → known digest). */
export function sha256HexUtf8(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Canonical privileged auth message.
 * pathWithQuery must be pathname + search (e.g. `/api/asp-set/path?label=1`).
 */
export function buildPrivilegedAuthMessage(args: {
  method: string;
  pathWithQuery: string;
  bodySha256: string;
  timestamp: string;
}): string {
  const method = args.method.trim().toUpperCase();
  const path = args.pathWithQuery.startsWith("/")
    ? args.pathWithQuery
    : `/${args.pathWithQuery}`;
  return `${PRIVILEGED_REQ_PREFIX}:${method}:${path}:${args.bodySha256}:${args.timestamp}`;
}

export function privilegedPathFromRequest(req: NextRequest): string {
  return `${req.nextUrl.pathname}${req.nextUrl.search}`;
}

/**
 * Solana wallets (Phantom) authenticate privileged proxies with an ed25519 signature over the SAME
 * message an EVM wallet would sign: `X-Wallet-Address` is the base58 pubkey (case-sensitive, never
 * lowercased) and `X-Signature` is the base64 64-byte signature from `signMessage(utf8(message))`.
 * No session-key delegation — that path is EVM-only.
 */
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function isSolanaWalletAddress(address: string): boolean {
  if (!SOLANA_PUBKEY_RE.test(address)) return false;
  try {
    return new PublicKey(address).toBytes().length === 32;
  } catch {
    return false;
  }
}

function solanaSignatureAuthorizes(message: string, signatureB64: string, wallet: string): boolean {
  try {
    const sig = Buffer.from(signatureB64, "base64");
    if (sig.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(new PublicKey(wallet).toBytes())]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

/** Keep in sync with solanaWalletAuth.EXECUTOR_SESSION_PREFIX and the executor's wallet_auth. */
const SOLANA_DEVNET_SESSION_PREFIX = "Siphon devnet session v1";
const SOLANA_DEVNET_SESSION_MAX_SEC = 24 * 60 * 60;

/**
 * Phantom's day-long Devnet session (the one signature the executor already takes per tab) also
 * opens the session-allowlisted proxies, so ASP reads stop costing a popup per route every 4 min.
 * Same scope as the soft session: cost/abuse routes only, never prove or admit.
 */
function verifySolanaDevnetSession(req: NextRequest, signature: string, nowSec: number): WalletAuthResult {
  const wallet = (req.headers.get("x-solana-address") || "").trim();
  const expires = Number((req.headers.get("x-solana-expires") || "").trim());
  const deny = (detail: string): WalletAuthResult => ({
    ok: false,
    status: 401,
    body: { error: "wallet_auth_invalid", detail },
  });
  if (!privilegedPathAllowsSession(privilegedPathFromRequest(req))) return deny("session not allowed for this path");
  if (!isSolanaWalletAddress(wallet)) return deny("X-Solana-Address required");
  if (!Number.isInteger(expires) || expires <= nowSec || expires > nowSec + SOLANA_DEVNET_SESSION_MAX_SEC + 60) {
    return { ok: false, status: 401, body: { error: "wallet_auth_expired", detail: "re-sign the Devnet session" } };
  }
  const message = `${SOLANA_DEVNET_SESSION_PREFIX}\nwallet:${wallet}\nexpires:${expires}`;
  return solanaSignatureAuthorizes(message, signature, wallet) ? { ok: true, wallet } : deny("session signature mismatch");
}

/** Normalised wallet header: lowercase 0x for EVM, verbatim base58 for Solana. */
function walletFromHeader(req: NextRequest): { wallet: string; solana: boolean } {
  const raw = (req.headers.get("x-wallet-address") || "").trim();
  if (isSolanaWalletAddress(raw)) return { wallet: raw, solana: true };
  return { wallet: raw.toLowerCase(), solana: false };
}

function authorizes(
  req: NextRequest,
  message: string,
  signature: string,
  wallet: string,
  solana: boolean,
  nowSec: number,
): boolean {
  return solana
    ? solanaSignatureAuthorizes(message, signature, wallet)
    : recoveredAuthorizes(req, message, signature, wallet, nowSec);
}

/**
 * Recover the signer of `message` and decide whether it authenticates `wallet`.
 *
 * Two accepted paths, in this order:
 *
 *   1. The wallet signed it directly. This is the pre-existing behaviour and is tried FIRST, so
 *      SDKs, agents and any un-migrated caller keep working unchanged. There is no flag day.
 *   2. A session key signed it, and the request carries a delegation proving that key was
 *      authorized by `wallet`. See sessionKey.ts for why the delegation travels per-request:
 *      Next routes run in Amplify SSR Lambdas with no shared store, so there is nowhere to
 *      persist sessionAddress -> wallet. Verification is therefore two signature recoveries and
 *      no lookup.
 *
 * The delegation is only consulted when direct recovery FAILS, so the common path costs nothing
 * extra and a valid wallet signature can never be overridden by a delegation header.
 */
function recoveredAuthorizes(
  req: NextRequest,
  message: string,
  signature: string,
  wallet: string,
  nowSec: number,
): boolean {
  try {
    if (verifyMessage(message, signature).toLowerCase() === wallet) return true;
  } catch {
    /* not a direct wallet signature — try the delegation below */
  }

  const raw = req.headers.get(SESSION_HEADER);
  if (!raw) return false;

  // Bind to this origin: a delegation signed for another host must not authenticate here. The
  // public domains count as this origin too: www.siphon.money is served by a reverse proxy that
  // reaches Amplify under its own hostname, so the Host header here is the amplifyapp one while
  // the browser signed for www.siphon.money.
  const host = req.headers.get("host") || undefined;
  const del = verifyDelegation(raw, {
    nowSec,
    expectedDomain: host ? [host, ...PUBLIC_APP_HOSTS] : undefined,
  });
  if (!del) return false;
  // The delegation must belong to the wallet the request claims to be.
  if (del.wallet !== wallet) return false;

  try {
    // And the request itself must be signed by the delegated key, not merely accompanied by a
    // delegation — otherwise any holder of a public delegation blob could impersonate the wallet.
    return verifyMessage(message, signature).toLowerCase() === del.sessionAddress.toLowerCase();
  } catch {
    return false;
  }
}

export function verifyWalletAuthHeaders(
  req: NextRequest,
  env: NodeJS.ProcessEnv = process.env,
  nowSec = Math.floor(Date.now() / 1000),
  opts?: VerifyWalletAuthOptions,
): WalletAuthResult {
  if (!walletAuthRequired(env)) {
    const wallet = (req.headers.get("x-wallet-address") || "").trim().toLowerCase();
    return { ok: true, wallet: wallet || "optional" };
  }

  const wallet = (req.headers.get("x-wallet-address") || "").trim().toLowerCase();
  const signature = (req.headers.get("x-signature") || "").trim();
  const timestamp = (req.headers.get("x-timestamp") || "").trim();

  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
    return {
      ok: false,
      status: 401,
      body: { error: "wallet_auth_required", detail: "X-Wallet-Address required" },
    };
  }
  if (!signature || !timestamp) {
    return {
      ok: false,
      status: 401,
      body: { error: "wallet_auth_required", detail: "X-Signature and X-Timestamp required" },
    };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) {
    return {
      ok: false,
      status: 401,
      body: { error: "wallet_auth_invalid", detail: "bad timestamp" },
    };
  }

  const age = nowSec - ts;
  const maxAge = opts?.maxAgeSec ?? walletAuthMaxAgeSec(env);
  if (age < -120 || age > maxAge) {
    return {
      ok: false,
      status: 401,
      body: { error: "wallet_auth_expired", detail: "re-sign Siphon auth v1" },
    };
  }

  if (
    !recoveredAuthorizes(
      req,
      `${WALLET_AUTH_MESSAGE_PREFIX}:${timestamp}`,
      signature,
      wallet,
      nowSec,
    )
  ) {
    return {
      ok: false,
      status: 401,
      body: { error: "wallet_auth_invalid", detail: "signature mismatch" },
    };
  }

  return { ok: true, wallet };
}

/**
 * Request-bound auth for privileged Next proxies (OMEGA-01).
 * Rejects unbound `Siphon auth v1:<ts>` blobs even if they are fresh.
 */
export function verifyPrivilegedWalletAuthHeaders(
  req: NextRequest,
  bodyText: string,
  env: NodeJS.ProcessEnv = process.env,
  nowSec = Math.floor(Date.now() / 1000),
  opts?: VerifyWalletAuthOptions,
): WalletAuthResult {
  if (!walletAuthRequired(env)) {
    return { ok: true, wallet: walletFromHeader(req).wallet || "optional" };
  }

  const solanaSession = (req.headers.get("x-solana-session") || "").trim();
  if (solanaSession) return verifySolanaDevnetSession(req, solanaSession, nowSec);

  const { wallet, solana } = walletFromHeader(req);
  const signature = (req.headers.get("x-signature") || "").trim();
  const timestamp = (req.headers.get("x-timestamp") || "").trim();

  if (!wallet || (!solana && !/^0x[0-9a-f]{40}$/.test(wallet))) {
    return {
      ok: false,
      status: 401,
      body: { error: "wallet_auth_required", detail: "X-Wallet-Address required" },
    };
  }
  if (!signature || !timestamp) {
    return {
      ok: false,
      status: 401,
      body: { error: "wallet_auth_required", detail: "X-Signature and X-Timestamp required" },
    };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) {
    return {
      ok: false,
      status: 401,
      body: { error: "wallet_auth_invalid", detail: "bad timestamp" },
    };
  }

  const age = nowSec - ts;
  const maxAge = opts?.maxAgeSec ?? privilegedWalletAuthMaxAgeSec(env);
  if (age < -120 || age > maxAge) {
    return {
      ok: false,
      status: 401,
      body: { error: "wallet_auth_expired", detail: "re-sign Siphon auth v1:req" },
    };
  }

  const pathWithQuery = privilegedPathFromRequest(req);
  const authMode = (req.headers.get("x-auth-mode") || "").trim().toLowerCase();
  const headerHashEarly = (req.headers.get("x-body-sha256") || "").trim().toLowerCase();
  const wantsSession =
    authMode === "session" || headerHashEarly === "session";

  // Soft privileged session: one sign → one allowlisted route prefix (OVERLORD F-6).
  if (wantsSession) {
    if (!privilegedPathAllowsSession(pathWithQuery)) {
      return {
        ok: false,
        status: 401,
        body: { error: "wallet_auth_invalid", detail: "session not allowed for this path" },
      };
    }
    const pathname = pathWithQuery.split("?")[0] || pathWithQuery;
    if (
      authorizes(
        req,
        buildPrivilegedSessionMessage(timestamp, pathname),
        signature,
        wallet,
        solana,
        nowSec,
      )
    ) {
      return { ok: true, wallet };
    }
    return {
      ok: false,
      status: 401,
      body: { error: "wallet_auth_invalid", detail: "session signature mismatch" },
    };
  }

  const bodySha256 = sha256HexUtf8(bodyText ?? "");
  const headerHash = headerHashEarly;
  const method = req.method || "GET";
  const wantsScope = headerHash === PRIVILEGED_PATH_SCOPE_BODY;
  const allowScope = wantsScope && privilegedPathAllowsScope(pathWithQuery);

  if (headerHash && headerHash !== bodySha256 && !allowScope) {
    return {
      ok: false,
      status: 401,
      body: { error: "wallet_auth_invalid", detail: "body hash mismatch" },
    };
  }

  const tryVerify = (hash: string): boolean =>
    authorizes(
      req,
      buildPrivilegedAuthMessage({ method, pathWithQuery, bodySha256: hash, timestamp }),
      signature,
      wallet,
      solana,
      nowSec,
    );

  // Path-scope session (builder etc.): method+path+TTL, any body. Not valid on prove/ASP.
  if (allowScope && tryVerify(PRIVILEGED_PATH_SCOPE_BODY)) {
    return { ok: true, wallet };
  }

  // Exact body binding (OMEGA-01 default).
  if (tryVerify(bodySha256)) {
    return { ok: true, wallet };
  }

  return {
    ok: false,
    status: 401,
    body: { error: "wallet_auth_invalid", detail: "signature mismatch" },
  };
}

export function walletAuthResponse(result: WalletAuthResult): NextResponse | null {
  if (result.ok) return null;
  return NextResponse.json(result.body, { status: result.status });
}

/** Same-origin browser calls only — blocks trivial curl without Origin/Referer spoofing. */
export function assertBrowserSameOrigin(
  req: NextRequest,
  env: NodeJS.ProcessEnv = process.env,
): WalletAuthFail | null {
  // See secFetchSiteAllows: a same-origin GET carries no Origin, and this app strips Referer,
  // so the header pair below cannot be the primary signal.
  const bySecFetch = secFetchSiteAllows(req.headers.get("sec-fetch-site"));
  if (bySecFetch === true) return null;
  if (bySecFetch === false) {
    return { ok: false, status: 403, body: { error: "origin_forbidden" } };
  }

  const host = req.headers.get("host") || "";
  if (!host) return null; // some platforms omit; don't hard-fail

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (!isSameSiteHost(new URL(origin).host, host)) {
        return {
          ok: false,
          status: 403,
          body: { error: "origin_forbidden" },
        };
      }
      return null;
    } catch {
      return { ok: false, status: 403, body: { error: "origin_forbidden" } };
    }
  }

  const referer = req.headers.get("referer");
  if (referer) {
    try {
      if (!isSameSiteHost(new URL(referer).host, host)) {
        return {
          ok: false,
          status: 403,
          body: { error: "origin_forbidden" },
        };
      }
      return null;
    } catch {
      return { ok: false, status: 403, body: { error: "origin_forbidden" } };
    }
  }

  // Production: require Origin or Referer (matches middleware). Spoofable by tools, but
  // blocks dumb scrapers; real auth remains wallet sig (AUTH-03).
  if (isProductionRuntime(env)) {
    return {
      ok: false,
      status: 403,
      body: { error: "origin_required" },
    };
  }

  // Dev/test: allow missing Origin for unit tests and some WebViews.
  return null;
}
