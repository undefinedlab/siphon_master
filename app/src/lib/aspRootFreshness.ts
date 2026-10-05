import { id } from "ethers";
import { PublicKey } from "@solana/web3.js";
import { solanaZkProgramId } from "@/lib/chains/solanaZkProgram";
import { getServerRpcUrls } from "@/lib/rpcServer";

type Roots = { admittedRoot?: unknown; revokedRoot?: unknown };

export type AspRootFreshness =
  | { ok: true }
  | { ok: false; error: "invalid_chainId" | "root_check_unconfigured" | "root_check_unavailable" | "publish_pending" };

const ADMITTED_ROOT_SELECTOR = id("admittedRoot()").slice(0, 10);
const REVOKED_ROOT_SELECTOR = id("revokedRoot()").slice(0, 10);

function chainConfig(chainId: number): { rpc: string; hub: string } | null {
  if (chainId === 8453) {
    return {
      rpc: (process.env.BASE_MAINNET_RPC || process.env.BASE_RPC_URL || "").trim(),
      hub: (process.env.NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB || "").trim(),
    };
  }
  if (chainId === 42161) {
    return {
      rpc: (process.env.ARBITRUM_RPC || "https://arb1.arbitrum.io/rpc").trim(),
      hub: (process.env.NEXT_PUBLIC_V3_ARBITRUM_COMPLIANCE_HUB || "").trim(),
    };
  }
  if (chainId === 11155111) {
    return {
      rpc: (process.env.ETH_SEPOLIA_RPC || "").trim(),
      hub: (process.env.NEXT_PUBLIC_V3_SEPOLIA_COMPLIANCE_HUB || "").trim(),
    };
  }
  return null;
}

function decimalRoot(value: unknown): string | null {
  try {
    if (value === undefined || value === null || value === "") return null;
    return BigInt(String(value)).toString();
  } catch {
    return null;
  }
}

/** Solana Devnet ZK vault: roots live in the program's compliance PDA, not an EVM hub. */
const SOLANA_ZK_CHAIN_ID = 900002;
const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** ComplianceAccount: disc(8) | bump(1) | admitted_root LE32 | revoked_root LE32. */
async function solanaComplianceRoots(fetcher: typeof fetch): Promise<{ admitted: string; revoked: string }> {
  const rpc = (
    process.env.SOLANA_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    "https://api.devnet.solana.com"
  ).trim();
  const programId = solanaZkProgramId();
  if (!rpc) throw new Error("solana root check unconfigured");
  const [compliance] = PublicKey.findProgramAddressSync(
    [Buffer.from("siphon-compliance-v1")],
    new PublicKey(programId),
  );
  const response = await fetcher(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [compliance.toBase58(), { encoding: "base64", commitment: "confirmed" }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`solana RPC HTTP ${response.status}`);
  const body = (await response.json()) as { result?: { value?: { data?: [string, string] } | null } };
  const b64 = body.result?.value?.data?.[0];
  if (!b64) throw new Error("compliance account missing");
  const data = Buffer.from(b64, "base64");
  const le = (start: number) => {
    let v = 0n;
    for (let i = start + 31; i >= start; i--) v = (v << 8n) | BigInt(data[i]);
    return (v % BN254_FR).toString();
  };
  return { admitted: le(9), revoked: le(41) };
}

async function ethCall(
  rpc: string,
  hub: string,
  data: string,
  fetcher: typeof fetch,
): Promise<string> {
  const response = await fetcher(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: hub, data }, "latest"],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`root RPC HTTP ${response.status}`);
  const body = (await response.json()) as { result?: string; error?: unknown };
  if (body.error || !body.result) throw new Error("root RPC failed");
  return BigInt(body.result).toString();
}

/**
 * Configured RPC first, then the same public fallbacks the /api/rpc proxy uses. Both paid Base
 * keys ran out of quota on 2026-10-06 (dRPC 403 "User balance exceeded", Alchemy 429) and this
 * gate — the only single-RPC path — 503'd every Base deposit while mainnet.base.org was healthy.
 * Falls through on transport/RPC errors only; a root MISMATCH is an answer, not a failure.
 */
async function ethCallAny(
  rpcs: string[],
  hub: string,
  data: string,
  fetcher: typeof fetch,
): Promise<string> {
  let last: unknown = new Error("no root RPC");
  for (const rpc of rpcs) {
    try {
      return await ethCall(rpc, hub, data, fetcher);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/**
 * Compare roots served by the ASP with the selected chain's ComplianceHub.
 *
 * The v5 ASP database is shared by Base and Sepolia while each hub publishes on its own epoch.
 * During that short skew window a locally-valid proof reverts on-chain. This server-side gate
 * turns it into a retryable 503 before the browser proves or the relayer spends gas.
 */
export async function verifyAspRootsCurrent(
  chainIdRaw: string | null,
  roots: Roots,
  fetcher: typeof fetch = fetch,
): Promise<AspRootFreshness> {
  if (!chainIdRaw) return { ok: true }; // Legacy callers; v5 callers always scope the chain.
  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) return { ok: false, error: "invalid_chainId" };
  const admitted = decimalRoot(roots.admittedRoot);
  const revoked = decimalRoot(roots.revokedRoot);

  if (chainId === SOLANA_ZK_CHAIN_ID) {
    if (admitted === null && revoked === null) return { ok: false, error: "root_check_unavailable" };
    try {
      const onchain = await solanaComplianceRoots(fetcher);
      if ((admitted !== null && admitted !== onchain.admitted) || (revoked !== null && revoked !== onchain.revoked)) {
        return { ok: false, error: "publish_pending" };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "root_check_unavailable" };
    }
  }

  const cfg = chainConfig(chainId);
  const rpcs = cfg ? [...new Set([cfg.rpc, ...getServerRpcUrls(chainId)].filter(Boolean))] : [];
  if (!cfg || rpcs.length === 0 || !/^0x[0-9a-fA-F]{40}$/.test(cfg.hub)) {
    return { ok: false, error: "root_check_unconfigured" };
  }

  if (admitted === null && revoked === null) return { ok: false, error: "root_check_unavailable" };

  try {
    const [onchainAdmitted, onchainRevoked] = await Promise.all([
      admitted === null ? Promise.resolve(null) : ethCallAny(rpcs, cfg.hub, ADMITTED_ROOT_SELECTOR, fetcher),
      revoked === null ? Promise.resolve(null) : ethCallAny(rpcs, cfg.hub, REVOKED_ROOT_SELECTOR, fetcher),
    ]);
    if (
      (admitted !== null && admitted !== onchainAdmitted) ||
      (revoked !== null && revoked !== onchainRevoked)
    ) {
      return { ok: false, error: "publish_pending" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "root_check_unavailable" };
  }
}
