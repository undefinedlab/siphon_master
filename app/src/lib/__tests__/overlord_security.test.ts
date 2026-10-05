// @ts-expect-error Bun test runtime
import { describe, expect, test, beforeEach } from "bun:test";
import { Wallet } from "ethers";
import {
  buildPrivilegedSessionMessage,
  verifyPrivilegedWalletAuthHeaders,
} from "../apiWalletAuth";
import { buildCspPolicyValue, connectSrcSources } from "../csp";
import { gateOutboundProxy } from "../outboundProxyGate";
import { resetGraphHttpRateLimit } from "../graphHttpGuard";
import { rpcContractAllowlist, rpcTargetsAllowed } from "../rpcHttpGuard";

function mockNextRequest(
  path: string,
  headers: Record<string, string> = {},
): import("next/server").NextRequest {
  const url = new URL(path, "http://localhost:3000");
  return {
    nextUrl: url,
    headers: new Headers(headers),
    method: headers["x-method"] || "GET",
  } as import("next/server").NextRequest;
}

describe("OVERLORD F-1 — CSP sslip.io wildcard removed", () => {
  test("connect-src must not list sslip.io wildcard", () => {
    const sources = connectSrcSources(process.env);
    expect(sources.includes("https://*.sslip.io")).toBe(false);
    expect(buildCspPolicyValue(process.env)).not.toContain("*.sslip.io");
  });
});

describe("OVERLORD F-3 — production eth_call target allowlist", () => {
  const prodEnv = { NODE_ENV: "production", VERCEL_ENV: "production" } as NodeJS.ProcessEnv;
  const allowed = rpcContractAllowlist(8453, prodEnv);
  const entry = allowed.values().next().value as string;

  test("rejects eth_call to arbitrary contract in production", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", data: "0x" }, "latest"],
    });
    expect(rpcTargetsAllowed(body, 8453, prodEnv)).toBe(false);
  });

  test("allows eth_call to NETWORKS entrypoint in production", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: entry, data: "0x" }, "latest"],
    });
    expect(rpcTargetsAllowed(body, 8453, prodEnv)).toBe(true);
  });

  test("RPC_ENFORCE_CALL_ALLOWLIST=0 opts out in production", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", data: "0x" }, "latest"],
    });
    expect(
      rpcTargetsAllowed(body, 8453, { ...prodEnv, RPC_ENFORCE_CALL_ALLOWLIST: "0" }),
    ).toBe(true);
  });
});

describe("OVERLORD F-4 — outbound proxy rate limits", () => {
  beforeEach(() => resetGraphHttpRateLimit());

  test("returns 429 after bucket exhaustion", () => {
    const req = mockNextRequest("/api/verify-quote", {
      "cf-connecting-ip": "203.0.113.50",
    });
    for (let i = 0; i < 20; i++) {
      expect(gateOutboundProxy(req, "verify-quote", 20)).toBeNull();
    }
    const blocked = gateOutboundProxy(req, "verify-quote", 20);
    expect(blocked?.status).toBe(429);
  });
});

describe("OVERLORD F-6 — privileged session bound to route", () => {
  test("session message includes pathname", () => {
    expect(buildPrivilegedSessionMessage("1700000000", "/api/builder-agent")).toBe(
      "Siphon auth v1:session:/api/builder-agent:1700000000",
    );
    expect(buildPrivilegedSessionMessage("1700000000", "/api/asp-screen")).not.toBe(
      buildPrivilegedSessionMessage("1700000000", "/api/builder-agent"),
    );
  });

  test("session signed for builder-agent rejected on asp-screen", async () => {
    const wallet = Wallet.createRandom();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await wallet.signMessage(
      buildPrivilegedSessionMessage(timestamp, "/api/builder-agent"),
    );
    const req = mockNextRequest("/api/asp-screen", {
      "x-wallet-address": wallet.address,
      "x-signature": signature,
      "x-timestamp": timestamp,
      "x-auth-mode": "session",
      "x-body-sha256": "session",
    });
    const result = verifyPrivilegedWalletAuthHeaders(req, "", {}, Number(timestamp) + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.body.error).toBe("wallet_auth_invalid");
  });

  test("session accepted on matching route", async () => {
    const wallet = Wallet.createRandom();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await wallet.signMessage(
      buildPrivilegedSessionMessage(timestamp, "/api/asp-screen"),
    );
    const req = mockNextRequest("/api/asp-screen", {
      "x-wallet-address": wallet.address,
      "x-signature": signature,
      "x-timestamp": timestamp,
      "x-auth-mode": "session",
      "x-body-sha256": "session",
    });
    const result = verifyPrivilegedWalletAuthHeaders(req, "", {}, Number(timestamp) + 1);
    expect(result.ok).toBe(true);
  });
});

describe("OVERLORD F-2/F-5/F-7 — CI gates", () => {
  test("security check script list includes csp and rpcQuota self-checks", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const script = readFileSync(join(import.meta.dir, "../../../scripts/run-security-checks.mjs"), "utf8");
    expect(script).toContain("csp.check.ts");
    expect(script).toContain("rpcQuota.check.ts");
    const ci = readFileSync(join(import.meta.dir, "../../../.github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("security:check");
    expect(ci).toContain("ceremony:check");
    expect(ci).toContain("lint:security");
  });
});

describe("OVERLORD F-8 — v3 ASP reads use wallet-auth proxies", () => {
  test("aspClientV3 routes through /api/asp-set not direct /set/", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dir, "../v3/aspClientV3.ts"), "utf8");
    expect(src).toContain('proxyGet("/api/asp-set/root", chainId)');
    expect(src).toContain("/api/asp-set/smt-path");
    expect(src).not.toMatch(/fetch\(\`\$\{base\(aspUrl\)\}\/set\//);
  });
});

describe("OVERLORD F-9 — smt-path proxy exists", () => {
  test("asp-set smt-path route is present", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const route = readFileSync(
      join(import.meta.dir, "../../app/api/asp-set/smt-path/route.ts"),
      "utf8",
    );
    expect(route).toContain('aspSetUpstreamUrl(base, "smt-path")');
    expect(route).toContain("gatePrivilegedProxy");
  });
});

describe("v3 pending ragequit — postman token stays server-side", () => {
  test("exit-ticket proxy authenticates the wallet and verifies the exact deposit receipt", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const route = readFileSync(
      join(import.meta.dir, "../../app/api/asp-revoke/route.ts"),
      "utf8",
    );
    expect(route).toContain("gatePrivilegedProxy");
    expect(route).toContain("requireWalletMatch");
    expect(route).toContain("assertV3ExitTicketReceipt");
    expect(route).toContain("aspPostmanProxyHeaders");

    const serverUrl = readFileSync(join(import.meta.dir, "../aspServerUrl.ts"), "utf8");
    expect(serverUrl).toContain('headers["X-Asp-Postman-Token"] = token');

    const verifier = readFileSync(join(import.meta.dir, "../aspAdmitReceipt.ts"), "utf8");
    expect(verifier).toContain("eth_getTransactionByHash");
    expect(verifier).toContain("user_salt_mismatch");
    expect(verifier).toContain("eth_getBlockByNumber");
    expect(verifier).toContain("ragequit_grace_expired");
  });
});

describe("OVERLORD F-10 — Sentry tunnel rate limit", () => {
  beforeEach(() => resetGraphHttpRateLimit());

  test("monitoring bucket exhausts to 429", () => {
    const req = mockNextRequest("/api/monitoring", { "cf-connecting-ip": "203.0.113.99" });
    for (let i = 0; i < 120; i++) {
      expect(gateOutboundProxy(req, "monitoring", 120)).toBeNull();
    }
    expect(gateOutboundProxy(req, "monitoring", 120)?.status).toBe(429);
  });
});

describe("OVERLORD F-11 — market-data outbound rate limits", () => {
  beforeEach(() => resetGraphHttpRateLimit());

  test("fear-greed bucket exhausts", () => {
    const req = mockNextRequest("/api/fear-greed", { "cf-connecting-ip": "203.0.113.77" });
    for (let i = 0; i < 30; i++) {
      expect(gateOutboundProxy(req, "fear-greed", 30)).toBeNull();
    }
    expect(gateOutboundProxy(req, "fear-greed", 30)?.status).toBe(429);
  });
});

describe("OVERLORD F-12 — Polymarket upstream cap", () => {
  test("events route caps Gamma pages and limit", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(import.meta.dir, "../../app/api/polymarket/events/route.ts"),
      "utf8",
    );
    expect(src).toContain("MAX_GAMMA_PAGES = 2");
    expect(src).toContain("MAX_EVENTS_LIMIT = 200");
    expect(src).not.toContain(", 300");
  });
});

describe("OVERLORD F-13 — graph same-origin gate", () => {
  test("graph route calls assertBrowserSameOrigin", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dir, "../../app/api/graph/route.ts"), "utf8");
    expect(src).toContain("assertBrowserSameOrigin(req)");
  });
});
