// Runnable self-check: connect-src must not include the sslip.io DNS-rebinding wildcard.
//   npx tsx src/lib/csp.check.ts
import assert from "node:assert";
import { buildCspPolicyValue, connectSrcSources, parseCspDirectives } from "./csp";

function main() {
  const list = connectSrcSources(process.env);
  assert.ok(
    !list.includes("https://*.sslip.io"),
    "connect-src must not contain the sslip.io wildcard — use env-derived executor origins instead",
  );

  const policy = buildCspPolicyValue(process.env);
  const directives = parseCspDirectives(policy);
  const connectTokens = directives["connect-src"] ?? [];
  assert.ok(
    !connectTokens.includes("https://*.sslip.io"),
    "built CSP connect-src still contains sslip.io wildcard",
  );

  assert.ok(!policy.includes("*.sslip.io"), "CSP policy still allows sslip.io wildcard");

  // The ZK artifact origin must be in connect-src. Proving keys are fetched cross-origin from S3
// since they left the bundle, so a CSP that omits this host fails fullProve() with "Failed to
// fetch" — and it fails EVERY proving path at once: withdraw, merge, swap, strategy legs.
{
  const env = {
    NEXT_PUBLIC_ZK_BASE_URL: "https://siphon-zk-artifacts.s3.us-east-1.amazonaws.com",
  } as unknown as NodeJS.ProcessEnv;
  const sources = connectSrcSources(env);
  assert.ok(
    sources.some((s) => s.includes("siphon-zk-artifacts.s3.us-east-1.amazonaws.com")),
    `zk artifact origin missing from connect-src — proving would be blocked. got: ${sources.join(" ")}`,
  );
  // Unset must not inject a bogus entry: same-origin /zk/* is the default and needs no host.
  const none = connectSrcSources({} as unknown as NodeJS.ProcessEnv);
  assert.ok(
    !none.some((s) => s.includes("undefined") || s === "https://"),
    `an unset ZK base URL must add nothing, got: ${none.join(" ")}`,
  );
}

// The Solana Devnet vault reads and confirms over api.devnet.solana.com (https + wss); a configured
// RPC brings its own pair. Missing either kills every Devnet deposit/withdraw in the browser.
{
  const base = connectSrcSources({} as unknown as NodeJS.ProcessEnv);
  assert.ok(base.includes("https://api.devnet.solana.com") && base.includes("wss://api.devnet.solana.com"));
  const custom = connectSrcSources({ NEXT_PUBLIC_SOLANA_RPC_URL: "https://devnet.helius-rpc.com/?api-key=x" } as unknown as NodeJS.ProcessEnv);
  assert.ok(custom.includes("https://devnet.helius-rpc.com") && custom.includes("wss://devnet.helius-rpc.com"));
}

console.log("csp.check: OK — no sslip.io in connect-src; Solana Devnet RPC allowed");
}

main();
