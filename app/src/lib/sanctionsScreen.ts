/**
 * Deposit / withdraw compliance gate.
 *
 * 1. Prefer Siphon ASP (`S_screened`) via same-origin `/api/asp-screen` when the
 *    app server has `ASP_URL` configured (proxy holds `ASP_SCREEN_TOKEN`).
 * 2. Always run the Chainalysis on-chain oracle as a local belt-and-suspenders check
 *    (ASP already includes it when RPC is set; this covers ASP-off / ASP-down fail-open).
 *
 * Docs: go.chainalysis.com/chainalysis-oracle-docs.html
 */
import { Contract } from "ethers";
import { getReadProvider } from "./zkHandler";

// Addresses moved to ./sanctionsOracles so the /api/rpc guard can allowlist the exact contract
// this file calls. They were private here, so the guard had no way to know about them and the
// oracle eth_call was refused as rpc_target_forbidden — which, fail-closed, blocks every deposit.
import { ORACLE_CHAINS, oracleAddressFor } from "./sanctionsOracles";

const ORACLE_ABI = ["function isSanctioned(address) view returns (bool)"];

const _oracleCache = new Map<string, { sanctioned: boolean; ts: number }>();
const ORACLE_CACHE_TTL_MS = 60 * 60 * 1000;

export type AspScreenDecision = "admit" | "deny" | "pending";

export type AspScreenResult = {
  decision: AspScreenDecision;
  reasons: string[];
  decisionId?: string;
  setId?: string;
  policyVersion?: string;
  raw?: unknown;
};

/** True when the browser should call /api/asp-screen (server has ASP_URL). */
export function aspScreenEnabled(): boolean {
  // Client can't see ASP_URL; use public flag. Server route 503s if URL missing.
  const flag = (process.env.NEXT_PUBLIC_ASP_SCREEN || "1").trim().toLowerCase();
  return flag !== "0" && flag !== "false" && flag !== "no";
}

/**
 * How to treat ASP down / unconfigured from the client:
 * - closed (default when screening enabled): block deposit
 * - open: fall through to oracle-only
 */
export function aspFailClosed(): boolean {
  const v = (process.env.NEXT_PUBLIC_ASP_FAIL_CLOSED || "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

export function formatAspDenyMessage(reasons: string[]): string {
  const nice = reasons.length ? reasons.slice(0, 4).join(", ") : "policy";
  return `This deposit was blocked by Siphon screening (${nice}).`;
}

export const KYT_FEE_REQUIRED_MESSAGE =
  "Pay the one-time compliance fee in Trust → Level 1 before depositing.";

export function isKytFeeRequired(status: number, reasons: string[]): boolean {
  return status === 402 || reasons.includes("kyt_fee_required");
}

export function parseAspScreenPayload(data: unknown): AspScreenResult | { error: string; statusHint?: number } {
  if (!data || typeof data !== "object") {
    return { error: "empty_response" };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.error === "string") {
    return { error: obj.error };
  }
  const decision = obj.decision;
  if (decision !== "admit" && decision !== "deny" && decision !== "pending") {
    return { error: "invalid_decision" };
  }
  const reasons = Array.isArray(obj.reasons)
    ? obj.reasons.filter((r): r is string => typeof r === "string")
    : [];
  return {
    decision,
    reasons,
    decisionId: typeof obj.decisionId === "string" ? obj.decisionId : undefined,
    setId: typeof obj.setId === "string" ? obj.setId : undefined,
    policyVersion: typeof obj.policyVersion === "string" ? obj.policyVersion : undefined,
    raw: data,
  };
}

export async function screenWithAsp(args: {
  chainId: number;
  depositor: string;
  commitment?: string;
  /** Paired with `commitment` so the ASP can derive the label and open a pending record. */
  userSalt?: string;
  /** @deprecated ignored — never sent (HA-P6-12) */
  precommitment?: string;
  /** @deprecated ignored — never sent (HA-P6-12) */
  label?: string;
  asset?: string;
  txHash?: string;
}): Promise<AspScreenResult> {
  const { getSigner } = await import("./nexus");
  const { fetchWithWalletAuth } = await import("./walletAuthHeaders");
  const signer = getSigner();
  if (!signer) {
    throw new Error("Connect wallet to run ASP screening");
  }

  const res = await fetchWithWalletAuth(signer, "/api/asp-screen", {
    method: "POST",
    body: JSON.stringify({
      chainId: args.chainId,
      depositor: args.depositor,
      commitment: args.commitment,
      userSalt: args.userSalt,
      // Privacy: do not send label/precommitment — soft screen is depositor KYT only.
      asset: args.asset,
      txHash: args.txHash,
    }),
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  const parsed = parseAspScreenPayload(data);
  if ("error" in parsed) {
    if (
      res.status === 503 ||
      parsed.error === "asp_unconfigured" ||
      parsed.error === "asp_unreachable"
    ) {
      throw new AspUnavailableError(parsed.error);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(parsed.error);
    }
    throw new Error(parsed.error);
  }
  if (isKytFeeRequired(res.status, parsed.reasons)) {
    throw new KytFeeRequiredError();
  }
  if (!res.ok && parsed.decision !== "deny" && parsed.decision !== "pending") {
    throw new AspUnavailableError(`asp_http_${res.status}`);
  }
  return parsed;
}

export class AspUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AspUnavailableError";
  }
}

export class KytFeeRequiredError extends Error {
  constructor(message: string = KYT_FEE_REQUIRED_MESSAGE) {
    super(message);
    this.name = "KytFeeRequiredError";
  }
}

/**
 * True when oracle RPC errors should block (default) rather than allow.
 */
export function oracleFailClosed(): boolean {
  const v = (process.env.NEXT_PUBLIC_ASP_ORACLE_FAIL_CLOSED || "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

export class OracleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OracleUnavailableError";
  }
}

/**
 * True if `address` is on the OFAC sanctions list per the Chainalysis oracle for `chainId`.
 * Unsupported chains → false (no oracle). RPC errors → throw when fail-closed (default).
 */
export async function isSanctioned(address: string, chainId: number): Promise<boolean> {
  const addr = (address || "").toLowerCase();
  if (!addr || !ORACLE_CHAINS.has(chainId)) return false;

  const key = `${chainId}:${addr}`;
  const hit = _oracleCache.get(key);
  if (hit && Date.now() - hit.ts < ORACLE_CACHE_TTL_MS) return hit.sanctioned;

  try {
    const provider = getReadProvider(chainId);
    const oracle = new Contract(oracleAddressFor(chainId), ORACLE_ABI, provider);
    const sanctioned = Boolean(await oracle.isSanctioned(addr));
    _oracleCache.set(key, { sanctioned, ts: Date.now() });
    return sanctioned;
  } catch (e) {
    if (oracleFailClosed()) {
      console.warn(`[sanctions] oracle check failed for ${key} — failing closed:`, e);
      throw new OracleUnavailableError(
        `Sanctions oracle unavailable for chain ${chainId} — deposits paused until RPC recovers`,
      );
    }
    console.warn(`[sanctions] oracle check failed for ${key} — failing open:`, e);
    return false;
  }
}

/**
 * Throws a user-facing error if the address is sanctioned (oracle only).
 */
export async function assertNotSanctioned(address: string, chainId: number): Promise<void> {
  try {
    if (await isSanctioned(address, chainId)) {
      throw new Error(
        "This address is on a sanctions list and cannot be used with Siphon.",
      );
    }
  } catch (e) {
    if (e instanceof OracleUnavailableError) throw e;
    throw e;
  }
}

/**
 * Deposit gate: ASP `S_screened` (when enabled) + Chainalysis oracle.
 * Call after commitment/precommitment are known, before broadcasting the deposit tx.
 */
export async function assertDepositScreened(args: {
  address: string;
  chainId: number;
  commitment?: string;
  userSalt?: string;
  precommitment?: string;
  label?: string;
  asset?: string;
}): Promise<AspScreenResult | null> {
  const { address, chainId, commitment, precommitment, label, asset, userSalt } = args;

  if (aspScreenEnabled()) {
    try {
      const result = await screenWithAsp({
        chainId,
        depositor: address,
        commitment,
        userSalt,
        precommitment,
        label,
        asset,
      });
      if (result.decision === "deny") {
        throw new Error(formatAspDenyMessage(result.reasons));
      }
      if (result.decision === "pending") {
        if (result.reasons?.includes("kyt_fee_required")) {
          throw new KytFeeRequiredError();
        }
        const why = result.reasons?.length ? result.reasons.join(", ") : "dependency pending";
        throw new Error(
          `Deposit screening is temporarily pending (${why}). Try again shortly.`,
        );
      }
      // admit — still run oracle below
      await assertNotSanctioned(address, chainId);
      return result;
    } catch (e) {
      if (e instanceof AspUnavailableError) {
        if (aspFailClosed()) {
          throw new Error(
            "Compliance screening is unavailable. Deposits are paused until screening is back.",
          );
        }
        console.warn("[sanctions] ASP unavailable — falling back to oracle-only:", e.message);
      } else {
        throw e;
      }
    }
  }

  await assertNotSanctioned(address, chainId);
  return null;
}
