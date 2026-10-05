/**
 * Base URL for trade-executor API calls.
 *
 * The browser calls the trade-executor DIRECTLY (CORS is configured for the app origin),
 * NOT through Next.js. The former `/api/trade-executor/*` catch-all is permanently disabled
 * (410) — it was an unauthenticated open proxy. Vercel serverless also caps bodies at ~4.5MB,
 * so large FHE payloads must not go through Next anyway.
 *
 * Set `NEXT_PUBLIC_TRADE_EXECUTOR_URL` for a custom host (e.g. `http://localhost:5005` in dev).
 * Production builds fail closed if that env is missing (no baked-in host fallback).
 */
import { getSelectedChainId } from "@/lib/networks";

export const DEFAULT_TRADE_EXECUTOR_URL = "https://api.siphon.money";

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/** True when a public HTTPS page would ask Chrome for Local Network / loopback access. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isPublicBrowserOrigin(): boolean {
  if (typeof window === "undefined") return false;
  return !isLoopbackHost(window.location.hostname);
}

/**
 * A public site must never call loopback. That is what triggers Chrome's
 * "would like to access other services on this device" prompt — the page is probing
 * 127.0.0.1 / localhost on the user's machine.
 */
function refuseLoopbackFromPublicOrigin(url: string): string {
  if (url && isPublicBrowserOrigin() && isLoopbackUrl(url)) {
    throw new Error(
      `Trade executor is misconfigured for this host (${url}). ` +
        `Set NEXT_PUBLIC_TRADE_EXECUTOR_URL to a public HTTPS URL, not localhost.`,
    );
  }
  return url;
}

function isProductionClientEnv(): boolean {
  const v = (
    process.env.NEXT_PUBLIC_SIPHON_ENV ||
    process.env.SIPHON_ENV ||
    process.env.VERCEL_ENV ||
    process.env.NODE_ENV ||
    ""
  )
    .trim()
    .toLowerCase();
  return v === "production" || v === "prod" || v === "mainnet";
}

/**
 * Chains whose executor is a DIFFERENT host from the global one. Each executor holds its own
 * chain's hot wallet, strategies and (via its decryptor) the enclave that fires them, so a call
 * scoped to one of these chains must reach that host — /createStrategy on the Base executor would
 * arm an Arbitrum order against a kernel it has no key for. Literal member expressions so Next
 * inlines them into the client bundle (see configV3.ts ENV).
 */
const CHAIN_EXECUTOR_URLS: Record<number, string | undefined> = {
  42161: process.env.NEXT_PUBLIC_V3_ARBITRUM_EXECUTOR_URL,
  // Solana Devnet ZK. The global executor is often a local EVM process; this vault's
  // relay runs on the Solana host, which is up when 127.0.0.1:5020 is not.
  900002: process.env.NEXT_PUBLIC_SOLANA_DEVNET_EXECUTOR_URL,
};

/**
 * True for a per-chain executor that is NOT the global one. Such a host must never be handed a
 * credential the global executor accepts (see noteAuth F-1): it runs on different, lower-assurance
 * infrastructure, and the note-backup token is a static bearer.
 */
export function isPerChainExecutor(base: string): boolean {
  const b = normalizeBaseUrl(base || "");
  const global = normalizeBaseUrl(process.env.NEXT_PUBLIC_TRADE_EXECUTOR_URL || "");
  return (
    !!b &&
    b !== global &&
    Object.values(CHAIN_EXECUTOR_URLS).some((u) => normalizeBaseUrl(u || "") === b)
  );
}

/**
 * `chainId` defaults to the chain the dapp is on, so every existing caller follows the chain
 * toggle without being threaded a chain id. Chains without an override use the global executor.
 */
export function getTradeExecutorBaseUrl(chainId?: number): string {
  const id = chainId ?? (typeof window !== "undefined" ? getSelectedChainId() : undefined);
  const perChain = normalizeBaseUrl((id !== undefined && CHAIN_EXECUTOR_URLS[id]) || "");
  if (perChain) return refuseLoopbackFromPublicOrigin(perChain);

  const fromEnv = normalizeBaseUrl(
    process.env.TRADE_EXECUTOR_URL ||
      process.env.NEXT_PUBLIC_TRADE_EXECUTOR_URL ||
      "",
  );

  if (typeof window !== "undefined") {
    const browserUrl = normalizeBaseUrl(process.env.NEXT_PUBLIC_TRADE_EXECUTOR_URL || "");
    if (browserUrl) return refuseLoopbackFromPublicOrigin(browserUrl);
    if (isProductionClientEnv()) {
      throw new Error(
        "NEXT_PUBLIC_TRADE_EXECUTOR_URL is required in production (no default host fallback)",
      );
    }
    return DEFAULT_TRADE_EXECUTOR_URL;
  }

  if (fromEnv) return fromEnv;
  if (isProductionClientEnv()) {
    throw new Error(
      "TRADE_EXECUTOR_URL or NEXT_PUBLIC_TRADE_EXECUTOR_URL is required in production",
    );
  }
  return DEFAULT_TRADE_EXECUTOR_URL;
}
