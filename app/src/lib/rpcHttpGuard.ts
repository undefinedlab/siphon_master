/**
 * Guards for /api/rpc — keyed upstream burn protection without requiring wallet
 * headers on every ethers JsonRpcProvider call (those cannot attach Siphon auth).
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { assertBrowserSameOrigin } from "@/lib/apiWalletAuth";
import { secFetchSiteAllows } from "@/lib/sameSiteHost";
import {
  clientKeyFromRequest,
  isProductionRuntime,
  isRateLimited,
} from "@/lib/graphHttpGuard";
import { NETWORKS } from "@/lib/networks";
import { ORACLE_CHAINS, oracleAddressFor } from "./sanctionsOracles";

/** Read-only JSON-RPC methods the browser may need for Siphon. */
export const RPC_METHOD_ALLOWLIST = new Set([
  "eth_call",
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getLogs",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getBalance",
  "eth_getCode",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "eth_getStorageAt",
  "net_version",
  "web3_clientVersion",
]);

/** Heavier / archive-ish methods — tighter per-IP budget (PROXY-04). */
/**
 * Expensive upstream operations that deserve a tighter bucket than ordinary reads.
 *
 * eth_call is deliberately NOT here. Every contract view the dapp makes — getVault, merkleTree,
 * balanceOf — is an eth_call, so putting it in a 20/min bucket meant the dashboard could not
 * finish a single poll cycle and /api/rpc answered 429 in a loop. It is cheap and cacheable, and
 * the general per-chain budget already covers it. Range scans and gas estimation are the ones
 * that actually cost the upstream node.
 */
export const RPC_HEAVY_METHODS = new Set([
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getCode",
  "eth_estimateGas",
]);

const MAX_BODY_BYTES = Number(process.env.RPC_HTTP_MAX_BODY || String(512_000));
/**
 * OMEGA-05 set these to 60/20 per 60s per IP. That is below what one honest session needs: the
 * dashboard polls getVault + merkleTree + balances on an interval, ethers retries internally, and
 * a leaf scan issues a burst — so the dapp rate-limited itself and the private balance never
 * loaded. Several users behind one NAT share the bucket too. 600/min (10/s) still bounds abuse
 * while leaving real usage untouched; override per-env if a tighter cap is wanted.
 */
const RPC_RATE_MAX = Number(process.env.RPC_HTTP_RATE_MAX || "600");
const RPC_HEAVY_RATE_MAX = Number(process.env.RPC_HTTP_HEAVY_RATE_MAX || "120");
const RPC_BATCH_MAX = Number(process.env.RPC_HTTP_BATCH_MAX || "20");

export type RpcGuardFail = { ok: false; response: NextResponse };
export type RpcGuardOk = { ok: true; bodyText: string };
export type RpcGuardResult = RpcGuardFail | RpcGuardOk;

function jsonRpcError(status: number, message: string, code = -32600): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status },
  );
}

function normAddr(a: string): string {
  return a.trim().toLowerCase();
}

/** Entrypoints + well-known tokens/routers + optional RPC_ETH_CALL_ALLOWLIST env. */
export function rpcContractAllowlist(
  chainId: number,
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const set = new Set<string>();
  const net = NETWORKS[chainId];
  if (net) {
    for (const a of [
      net.entrypoint,
      net.weth,
      net.usdc,
      net.swapRouter,
      net.uniswapV3Factory,
    ]) {
      // A v3-only chain carries a zero `entrypoint`; 0x0 is never a legitimate call target.
      if (a && !/^0x0{40}$/i.test(a)) set.add(normAddr(a));
    }
  }
  const v3Keys = [
    "NEXT_PUBLIC_V3_SEPOLIA_VAULT_KERNEL",
    "NEXT_PUBLIC_V3_SEPOLIA_COMPLIANCE_HUB",
    "NEXT_PUBLIC_V3_SEPOLIA_SETTLEMENT_ADAPTER",
    "NEXT_PUBLIC_V3_BASE_VAULT_KERNEL",
    "NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB",
    "NEXT_PUBLIC_V3_BASE_SETTLEMENT_ADAPTER",
    "NEXT_PUBLIC_V3_ARBITRUM_VAULT_KERNEL",
    "NEXT_PUBLIC_V3_ARBITRUM_COMPLIANCE_HUB",
    "NEXT_PUBLIC_V3_ARBITRUM_SETTLEMENT_ADAPTER",
    // The NoteTree. The indexer-free fallback in stateLeavesClient rebuilds the state tree from
    // NoteTree.CommitmentInserted, so it issues eth_getLogs against THIS address — and eth_getLogs
    // is allowlisted by `filter.address` exactly like eth_call's `to`. Without these the fallback
    // 403s as rpc_target_forbidden, which is silent: it fails closed and the user just sees "state
    // leaves unavailable" again, i.e. the fallback would look implemented but never work.
    "NEXT_PUBLIC_V3_SEPOLIA_NOTE_TREE",
    "NEXT_PUBLIC_V3_BASE_NOTE_TREE",
    "NEXT_PUBLIC_V3_ARBITRUM_NOTE_TREE",
    // The NullifierSet. A strategy leg is spent by the ENCLAVE at fire time, not by this browser,
    // so loadV3Notes reconciles each local note against NullifierSet.isUsed() to learn it was
    // consumed. That reconcile FAILS OPEN by design (an RPC blip must never hide funds), so a
    // forbidden call is silent: the spent input note keeps counting and the dashboard shows both
    // sides of a filled order — 0.00001 ETH *and* the 0.024818 USDC it was sold for.
    "NEXT_PUBLIC_V3_SEPOLIA_NULLIFIER_SET",
    "NEXT_PUBLIC_V3_BASE_NULLIFIER_SET",
    "NEXT_PUBLIC_V3_ARBITRUM_NULLIFIER_SET",
  ];
  for (const key of v3Keys) {
    const t = (env[key] || "").trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(t)) set.add(normAddr(t));
  }
  // The Chainalysis sanctions oracle. isSanctioned() runs before every deposit and screens the
  // depositor, so it is the single most load-bearing eth_call in the app — and it was missing from
  // this list entirely, because the addresses were private to sanctionsScreen.ts. In production the
  // allowlist is enforced by default, so the call came back rpc_target_forbidden, the screen failed
  // CLOSED (the correct direction), and every deposit was refused with "Sanctions oracle
  // unavailable ... deposits paused until RPC recovers" while the RPC was perfectly healthy.
  if (ORACLE_CHAINS.has(chainId)) set.add(normAddr(oracleAddressFor(chainId)));

  const extra = (env.RPC_ETH_CALL_ALLOWLIST || "").split(",");
  for (const a of extra) {
    const t = a.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(t)) set.add(normAddr(t));
  }
  return set;
}

/** Extract method name(s) from a JSON-RPC single call or batch. */
export function rpcMethodsFromBody(bodyText: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const methods: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    const m = (item as { method?: unknown }).method;
    if (typeof m !== "string" || !m) return null;
    methods.push(m);
  }
  return methods;
}

export function allRpcMethodsAllowed(methods: string[]): boolean {
  return methods.every((m) => RPC_METHOD_ALLOWLIST.has(m));
}

/**
 * Target restrictions for /api/rpc (PROXY-04):
 * - Production always rejects unfiltered eth_getLogs (full-chain archive burns).
 * - Production defaults to enforced call-target allowlist (OVERLORD F-3). Set
 *   RPC_ENFORCE_CALL_ALLOWLIST=0 to opt out (break-glass only). Vault addresses are included
 *   via NETWORKS + v3 env + RPC_ETH_CALL_ALLOWLIST.
 */
export function rpcTargetsAllowed(
  bodyText: string,
  chainId: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const enforceFlag = (env.RPC_ENFORCE_CALL_ALLOWLIST || "").trim().toLowerCase();
  const prod = isProductionRuntime(env);
  const enforceAllowlist =
    enforceFlag === "0" || enforceFlag === "false"
      ? false
      : enforceFlag === "1" ||
        enforceFlag === "true" ||
        prod;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const allow = enforceAllowlist ? rpcContractAllowlist(chainId, env) : null;

  for (const item of items) {
    if (!item || typeof item !== "object") return false;
    const method = (item as { method?: string }).method;
    const params = (item as { params?: unknown[] }).params;

    if (method === "eth_getLogs") {
      const filter = params?.[0];
      if (!filter || typeof filter !== "object") return false;
      const addr = (filter as { address?: string | string[] }).address;
      if (!addr) {
        // Unfiltered log scans — always refuse in prod; refuse whenever allowlist enforced.
        if (prod || enforceAllowlist) return false;
        continue;
      }
      if (allow) {
        const addrs = Array.isArray(addr) ? addr : [addr];
        for (const a of addrs) {
          const n = normAddr(String(a));
          if (!/^0x[0-9a-f]{40}$/.test(n) || !allow.has(n)) return false;
        }
      }
    }

    if (!allow) continue;

    if (method === "eth_call") {
      const call = params?.[0];
      if (!call || typeof call !== "object") return false;
      const to = normAddr(String((call as { to?: string }).to || ""));
      if (!/^0x[0-9a-f]{40}$/.test(to) || !allow.has(to)) return false;
    }
    if (method === "eth_getStorageAt" || method === "eth_getCode") {
      const to = normAddr(String(params?.[0] || ""));
      if (!/^0x[0-9a-f]{40}$/.test(to) || !allow.has(to)) return false;
    }
  }
  return true;
}

/**
 * Same-origin + rate limit + body size + method allowlist (+ optional call targets).
 */
export function guardRpcProxyRequest(
  req: NextRequest,
  bodyText: string,
  env: NodeJS.ProcessEnv = process.env,
  chainId?: number,
  opts: { deferRateLimit?: boolean } = {},
): RpcGuardResult {
  const originDeny = assertBrowserSameOrigin(req, env);
  if (originDeny) {
    return {
      ok: false,
      response: NextResponse.json(originDeny.body, { status: originDeny.status }),
    };
  }

  const prod = isProductionRuntime(env);
  // Sec-Fetch-Site is authoritative when present (see secFetchSiteAllows). This path is POST-only
  // so Origin is normally there too, but keeping the three guards consistent stops the
  // same-origin-GET trap from being reintroduced here later.
  const bySecFetch = secFetchSiteAllows(req.headers.get("sec-fetch-site"));
  const hasOrigin =
    bySecFetch === true || Boolean(req.headers.get("origin") || req.headers.get("referer"));
  if (prod && !hasOrigin) {
    return {
      ok: false,
      response: jsonRpcError(403, "origin_required"),
    };
  }

  // Rate limiting can be deferred so the caller may serve a cached response first — a cache hit
  // costs no upstream call, so charging it against the budget is what let a polling dashboard
  // rate-limit itself. Structural checks below stay inline: they are free and must always run.
  if (!opts.deferRateLimit) {
    const limited = rpcRateLimitResponse(req, bodyText, env, chainId);
    if (limited) return { ok: false, response: limited };
  }

  if (Buffer.byteLength(bodyText, "utf8") > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: jsonRpcError(413, "payload too large", -32600),
    };
  }

  const methods = rpcMethodsFromBody(bodyText);
  if (!methods || methods.length === 0) {
    return {
      ok: false,
      response: jsonRpcError(400, "invalid json-rpc body"),
    };
  }
  if (methods.length > RPC_BATCH_MAX) {
    return {
      ok: false,
      response: jsonRpcError(413, "rpc_batch_too_large", -32600),
    };
  }
  if (!allRpcMethodsAllowed(methods)) {
    return {
      ok: false,
      response: jsonRpcError(403, "rpc_method_forbidden", -32601),
    };
  }

  const cid = resolveChainId(req, env, chainId);
  if (Number.isFinite(cid) && !rpcTargetsAllowed(bodyText, cid, env)) {
    return {
      ok: false,
      response: jsonRpcError(403, "rpc_target_forbidden", -32602),
    };
  }

  return { ok: true, bodyText };
}

function resolveChainId(
  req: NextRequest,
  env: NodeJS.ProcessEnv,
  chainId?: number,
): number {
  return (
    chainId ??
    parseInt(
      req.nextUrl?.searchParams?.get("chainId") ||
        env.NEXT_PUBLIC_DEFAULT_CHAIN_ID ||
        "8453",
      10,
    )
  );
}

/**
 * Per-IP request budget for the RPC proxy, or null when within budget.
 *
 * Buckets are keyed per CHAIN. Keying them on the IP alone made Base and Sepolia share one
 * allowance, so a dual-chain dashboard silently got half the budget it appeared to have — they
 * are separate upstreams and should not compete.
 *
 * Call this only for requests that will actually reach an upstream node; see the deferRateLimit
 * note in guardRpcProxyRequest.
 */
export function rpcRateLimitResponse(
  req: NextRequest,
  bodyText: string,
  env: NodeJS.ProcessEnv = process.env,
  chainId?: number,
): NextResponse | null {
  const ip = clientKeyFromRequest(req);
  const cid = resolveChainId(req, env, chainId);

  if (isRateLimited(`rpc:${cid}:${ip}`, RPC_RATE_MAX)) {
    return jsonRpcError(429, "rate_limited", -32005);
  }

  const methods = rpcMethodsFromBody(bodyText);
  if (methods?.some((m) => RPC_HEAVY_METHODS.has(m))) {
    if (isRateLimited(`rpc-heavy:${cid}:${ip}`, RPC_HEAVY_RATE_MAX)) {
      return jsonRpcError(429, "rate_limited_heavy", -32005);
    }
  }

  return null;
}

/** /api/rpc/stats — locked in production unless RPC_STATS_PUBLIC=1. */
export function authorizeRpcStats(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; response: NextResponse } {
  const allow =
    (env.RPC_STATS_PUBLIC || "").toLowerCase() === "true" ||
    env.RPC_STATS_PUBLIC === "1";
  if (isProductionRuntime(env) && !allow) {
    return {
      ok: false,
      response: NextResponse.json({ error: "rpc_stats_locked" }, { status: 404 }),
    };
  }
  return { ok: true };
}
