/**
 * Shared gate for privileged Next proxies that hold server secrets
 * (ASP screen token, OpenRouter key, etc.): same-origin + request-bound wallet auth + rate limit.
 *
 * OMEGA-01: verifies `Siphon auth v1:req:<METHOD>:<path>:<bodySha256>:<ts>` so unbound
 * localStorage blobs cannot be replayed across routes or bodies.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  assertBrowserSameOrigin,
  isSolanaWalletAddress,
  privilegedWalletAuthMaxAgeSec,
  verifyPrivilegedWalletAuthHeaders,
  walletAuthResponse,
  type WalletAuthResult,
} from "@/lib/apiWalletAuth";
import { clientKeyFromRequest, isRateLimited } from "@/lib/graphHttpGuard";

export type PrivilegedGateOk = { ok: true; wallet: string; bodyText: string };
export type PrivilegedGateFail = { ok: false; response: NextResponse };
export type PrivilegedGateResult = PrivilegedGateOk | PrivilegedGateFail;

/**
 * Read body (if any) and verify request-bound privileged auth.
 * Callers must parse `bodyText` instead of calling `req.json()` again.
 */
export async function gatePrivilegedProxy(
  req: NextRequest,
  opts: {
    /** Rate-limit bucket prefix, e.g. "asp-screen" */
    bucket: string;
    max?: number;
    /**
     * When true (default), use short privileged auth TTL.
     */
    privilegedTtl?: boolean;
  },
): Promise<PrivilegedGateResult> {
  const originDeny = assertBrowserSameOrigin(req);
  if (originDeny) {
    return {
      ok: false,
      response: NextResponse.json(originDeny.body, { status: originDeny.status }),
    };
  }

  const method = (req.method || "GET").toUpperCase();
  let bodyText = "";
  if (method !== "GET" && method !== "HEAD") {
    try {
      bodyText = await req.text();
    } catch {
      return {
        ok: false,
        response: NextResponse.json({ error: "invalid_body" }, { status: 400 }),
      };
    }
  }

  const usePrivileged = opts.privilegedTtl !== false;
  const auth = verifyPrivilegedWalletAuthHeaders(
    req,
    bodyText,
    process.env,
    Math.floor(Date.now() / 1000),
    usePrivileged ? { maxAgeSec: privilegedWalletAuthMaxAgeSec() } : undefined,
  );
  const denied = walletAuthResponse(auth);
  if (denied) return { ok: false, response: denied };

  const wallet = (auth as Extract<WalletAuthResult, { ok: true }>).wallet;
  const max = opts.max ?? Number(process.env.PRIVILEGED_PROXY_RATE_MAX || "30");
  const ip = clientKeyFromRequest(req);
  if (isRateLimited(`${opts.bucket}:${ip}`, max)) {
    return { ok: false, response: NextResponse.json({ error: "rate_limited" }, { status: 429 }) };
  }
  if (wallet && wallet !== "optional" && isRateLimited(`${opts.bucket}:w:${wallet}`, max)) {
    return { ok: false, response: NextResponse.json({ error: "rate_limited" }, { status: 429 }) };
  }

  return { ok: true, wallet, bodyText };
}

/**
 * Require body/query address to equal the authenticated wallet: lowercase 0x for EVM, exact
 * base58 for Solana (case is significant there, so a Solana pair is never lowercased).
 */
export function requireWalletMatch(
  authenticated: string,
  claimed: string,
  field = "wallet",
): NextResponse | null {
  const solana = isSolanaWalletAddress(claimed.trim());
  const a = solana ? authenticated.trim() : authenticated.trim().toLowerCase();
  const c = solana ? claimed.trim() : claimed.trim().toLowerCase();
  if (!solana && !/^0x[0-9a-f]{40}$/.test(c)) {
    return NextResponse.json(
      { error: "invalid_request", message: `${field} must be a 0x address or Solana pubkey` },
      { status: 400 },
    );
  }
  if (a !== "optional" && a !== c) {
    return NextResponse.json(
      { error: `${field}_mismatch`, message: `${field} must match authenticated wallet` },
      { status: 403 },
    );
  }
  return null;
}
