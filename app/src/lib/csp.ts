/**
 * Content-Security-Policy for Siphon.
 *
 * Same directive set is used for Report-Only (always) and enforcing CSP (production
 * by default). Enforcing still allows 'unsafe-inline'/'unsafe-eval' for Next+snarkjs+FHE
 * but blocks off-origin script/connect/object/base-uri abuse. Escape hatch: CSP_ENFORCE=0.
 */

const CSP_REPORT_PATH = "/api/csp-report";

/** @internal exported for tests */
export function hostFromEnvUrl(envVal: string | undefined): string | null {
  if (!envVal?.trim()) return null;
  try {
    return new URL(envVal.trim()).origin;
  } catch {
    return null;
  }
}

/** Origins we already know the app talks to (wallets, RPC, data). Expand from reports. */
export function connectSrcSources(env: NodeJS.ProcessEnv = process.env): string[] {
  const extras = [
    hostFromEnvUrl(env.NEXT_PUBLIC_TRADE_EXECUTOR_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_VAULT_INDEX_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_LEGACY_VAULT_INDEX_URL),
    // v3 stack. These moved off *.sslip.io onto a real domain, which the static list below does
    // not cover — the ASP calls were logged as connect-src violations and only survived because
    // the policy is report-only. Under an enforcing CSP every membership lookup would be blocked.
    hostFromEnvUrl(env.NEXT_PUBLIC_V3_SEPOLIA_ASP_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_V3_SEPOLIA_EXECUTOR_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_V3_SEPOLIA_INDEXER_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_V3_BASE_ASP_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_V3_BASE_EXECUTOR_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_V3_BASE_INDEXER_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_V3_ARBITRUM_ASP_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_V3_ARBITRUM_EXECUTOR_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_SOLANA_DEVNET_EXECUTOR_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_V3_ARBITRUM_INDEXER_URL),
    // ZK artifact origin. The proving keys moved out of the bundle to S3 (the build output cannot
    // carry 2.8 GB), so snarkjs now fetches the wasm/zkey CROSS-ORIGIN at prove time. Without this
    // the CSP refuses the connection and fullProve() dies with "Failed to fetch" — every withdraw,
    // merge, swap and strategy leg, because all of them prove in the browser.
    hostFromEnvUrl(env.NEXT_PUBLIC_ZK_BASE_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_SUPABASE_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_ASI_API_BASE_URL),
    hostFromEnvUrl(env.NEXT_PUBLIC_ASI_API),
    // Sentry ingest. Derived from the DSN so only the project's own ingest host is
    // allowed — NOT a blanket *.sentry.io. Without this the CSP silently drops every
    // event and the dashboard looks installed but never receives anything.
    hostFromEnvUrl(env.NEXT_PUBLIC_SENTRY_DSN),
    // Solana RPC for the Devnet vault. web3.js confirms over a websocket on the same host, so the
    // wss:// twin is needed too — without it sends land but confirmTransaction never resolves.
    ...[env.NEXT_PUBLIC_SOLANA_RPC_URL, env.NEXT_PUBLIC_SOLANA_RPC].flatMap((u) => {
      const o = hostFromEnvUrl(u);
      return o ? [o, o.replace(/^http/, "ws")] : [];
    }),
    // NEXT_PUBLIC_PROVING_RELAYER_URL intentionally omitted — browser must not talk to a
    // public prover (witness privacy); proving goes through authenticated /api/prove.
  ].filter((x): x is string => Boolean(x));

  return [
    "'self'",
    "blob:",
    // Default executor host (overridden by env when set)
    "https://api.siphon.money",
    // sslip.io wildcard removed (OVERLORD F-1): *.sslip.io is a DNS-rebinding vector — any label
    // resolves to an attacker-chosen IP. Legacy sslip executor hosts must be listed via env above.
    // Supabase
    "https://*.supabase.co",
    "wss://*.supabase.co",
    // Public / configured RPCs (browser may hit these when not proxied via /api/rpc)
    "https://mainnet.base.org",
    "https://sepolia.base.org",
    "https://arb1.arbitrum.io",
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://rpc.moderato.tempo.xyz",
    "https://rpc.tempo.xyz",
    "wss://rpc.moderato.tempo.xyz",
    "https://explore.tempo.xyz",
    "https://cloudflare-eth.com",
    "https://*.publicnode.com",
    "https://*.g.alchemy.com",
    "https://*.alchemy.com",
    "https://*.infura.io",
    "https://*.drpc.org",
    // MetaMask Connect / SDK
    "https://*.metamask.io",
    "https://metamask-sdk.api.cx.metamask.io",
    "wss://*.metamask.io",
    // WalletConnect / Reown (RainbowKit stack if present)
    "https://*.walletconnect.com",
    "https://*.walletconnect.org",
    "wss://*.walletconnect.com",
    "wss://*.walletconnect.org",
    "https://*.reown.com",
    "wss://*.reown.com",
    "https://api.web3modal.org",
    "https://pulse.walletconnect.org",
    "https://explorer-api.walletconnect.com",
    "https://rpc.walletconnect.com",
    // zkMe zkKYC widget + verification APIs
    "https://*.zk.me",
    "https://nest-api.zk.me",
    "https://agw.zk.me",
    // LI.FI public API — "Fund from another chain" quotes and tracks its hop from the browser.
    "https://li.quest",
    // Solana Devnet default RPC (every Devnet deposit/withdraw/balance read). Never allowed before,
    // so under the enforcing CSP the whole Devnet vault was dead in the browser.
    "https://api.devnet.solana.com",
    "wss://api.devnet.solana.com",
    ...extras,
  ];
}

function frameSrcSources(): string[] {
  return [
    "'self'",
    "https://*.walletconnect.com",
    "https://*.walletconnect.org",
    "https://verify.walletconnect.com",
    "https://verify.walletconnect.org",
    "https://*.metamask.io",
    "https://*.reown.com",
    // TradingView advanced-chart embed (src/components/widgets/chart). It is a plain
    // iframe with no API key, so a missing entry here is invisible: the tile's header and
    // tab controls render as local DOM while the chart area stays blank, which reads as a
    // broken data feed rather than a blocked frame. The console violation names the host.
    "https://www.tradingview.com",
    "https://s.tradingview.com",
    // zkMe zkKYC widget iframe
    "https://*.zk.me",
  ];
}

/**
 * Absolute CSP report collector URL. Reporting API (Report-To) rejects relative paths —
 * Firefox logs "ignoring invalid endpoint URL" on every navigation when they are relative.
 */
export function resolveCspReportUrl(
  origin?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates: string[] = [];
  if (origin?.trim()) candidates.push(origin.trim());
  for (const key of [
    "NEXT_PUBLIC_APP_ORIGIN",
    "NEXT_PUBLIC_SITE_URL",
    "OPENROUTER_SITE_URL",
  ] as const) {
    const fromEnv = hostFromEnvUrl(env[key]);
    if (fromEnv) candidates.push(fromEnv);
  }
  const vercel = env.VERCEL_URL?.trim();
  if (vercel) {
    candidates.push(vercel.startsWith("http") ? vercel : `https://${vercel}`);
  }
  const amplify = env.AWS_AMPLIFY_HOSTNAME?.trim();
  if (amplify) {
    candidates.push(amplify.startsWith("http") ? amplify : `https://${amplify}`);
  }
  if ((env.NODE_ENV || "").trim().toLowerCase() === "development") {
    candidates.push("http://localhost:3000");
  }

  for (const base of candidates) {
    try {
      return new URL(CSP_REPORT_PATH, base).href;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** CSP violation reporting — off by default (no /api/csp-report collector yet). Set CSP_REPORT=1 to enable. */
export function cspReportingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CSP_REPORT || "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  return false;
}

/**
 * Shared CSP directive string (report-only and enforcing use the same allowlist).
 * 'unsafe-inline' / 'unsafe-eval' / wasm-unsafe-eval are expected for Next + snarkjs/FHE for now.
 */
export function buildCspPolicyValue(
  env: NodeJS.ProcessEnv = process.env,
  origin?: string,
): string {
  const reportUrl =
    cspReportingEnabled(env) ? resolveCspReportUrl(origin, env) : null;
  const directives: string[] = [
    "default-src 'self'",
    [
      "script-src",
      "'self'",
      "'unsafe-inline'",
      "'unsafe-eval'",
      "'wasm-unsafe-eval'",
      "blob:",
    ].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrcSources(env).join(" ")}`,
    `frame-src ${frameSrcSources().join(" ")}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://*.zk.me",
    "frame-ancestors 'none'",
  ];
  if (reportUrl) {
    directives.push(`report-uri ${reportUrl}`);
    directives.push("report-to csp-endpoint");
  }

  return directives.join("; ");
}

/** @deprecated alias — use buildCspPolicyValue */
export function buildCspReportOnlyValue(env: NodeJS.ProcessEnv = process.env): string {
  return buildCspPolicyValue(env);
}

/**
 * Whether to emit enforcing Content-Security-Policy.
 * Default: on in production. CSP_ENFORCE=0 disables; CSP_ENFORCE=1 forces on (e.g. staging soak).
 */
export function cspEnforceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CSP_ENFORCE || "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  const v = (env.VERCEL_ENV || env.SIPHON_ENV || env.NODE_ENV || "").trim().toLowerCase();
  return v === "production" || v === "prod";
}

/** Reporting API group (Chrome/Edge/Firefox). Paired with report-to in the CSP. */
export function buildCspReportToHeader(
  origin?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!cspReportingEnabled(env)) return null;
  const url = resolveCspReportUrl(origin, env);
  if (!url) return null;
  return JSON.stringify({
    group: "csp-endpoint",
    max_age: 10886400,
    endpoints: [{ url }],
  });
}

/** Origin for build-time headers (next.config). Middleware passes request.nextUrl.origin per request. */
export function resolveCspHeaderOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const reportUrl = resolveCspReportUrl(undefined, env);
  if (!reportUrl) return undefined;
  try {
    return new URL(reportUrl).origin;
  } catch {
    return undefined;
  }
}
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
export const REPORT_TO_HEADER = "Report-To";
export const CSP_ENFORCING_HEADER = "Content-Security-Policy";

/** Parse CSP into a map of directive → tokens (for tests / debugging). */
export function parseCspDirectives(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...rest] = trimmed.split(/\s+/);
    out[name] = rest;
  }
  return out;
}
