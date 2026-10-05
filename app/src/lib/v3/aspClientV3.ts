/**
 * Browser ASP client (v3) — compliance roots + per-label ASP inclusion and SMT paths.
 *
 * All reads go through same-origin `/api/asp-set/*` wallet-auth proxies (OVERLORD F-8).
 * The browser never calls `NEXT_PUBLIC_V3_*_ASP_URL` directly or holds ASP_SCREEN_TOKEN.
 */
import type { Signer } from "ethers";
import { fetchWithWalletAuth } from "../walletAuthHeaders";

export interface ComplianceRoots {
  admittedRoot: string;
  revokedRoot: string;
}

export interface InputCompliance {
  inLabel: string;
  admittedLeafIndex: number;
  admittedPathElements: string[];
  admittedPathIndices: number[];
  revokedSmtPathElements: string[];
  revokedSmtPathIndices: number[];
  revokedSmtLeaf: string;
}

export interface ComplianceWitness {
  admittedRoot: string;
  revokedRoot: string;
  inputs: InputCompliance[];
}

async function resolveSigner(): Promise<Signer | null> {
  try {
    const { getSigner } = await import("../nexus");
    return getSigner() ?? null;
  } catch {
    return null;
  }
}

function withChainId(path: string, chainId?: number): string {
  if (!chainId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}chainId=${encodeURIComponent(String(chainId))}`;
}

/** Solana Devnet ZK vault — its ASP reads authenticate with Phantom, not an EVM signer. */
const SOLANA_ZK_CHAIN_ID = 900002;

async function proxyGet(path: string, chainId?: number): Promise<Record<string, unknown>> {
  const scopedPath = withChainId(path, chainId);
  let res: Response;
  if (chainId === SOLANA_ZK_CHAIN_ID) {
    const { fetchWithSolanaAuth } = await import("../solanaWalletAuth");
    res = await fetchWithSolanaAuth(scopedPath, { method: "GET" });
  } else {
    const signer = await resolveSigner();
    if (!signer) {
      throw new Error("wallet required for v3 ASP set reads — connect wallet first");
    }
    res = await fetchWithWalletAuth(signer, scopedPath, { method: "GET" });
  }
  if (!res.ok) throw new Error(`asp ${scopedPath}: ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.error === "string" && data.error) {
    throw new Error(`asp ${scopedPath}: ${data.error}`);
  }
  return data;
}

function strArr(x: unknown): string[] {
  return Array.isArray(x) ? x.map((v) => String(v)) : [];
}
function numArr(x: unknown): number[] {
  return Array.isArray(x) ? x.map((v) => Number(v)) : [];
}

/** @deprecated aspUrl/screenToken ignored — reads use `/api/asp-set/*` proxies. */
export async function fetchComplianceRoots(
  _aspUrl?: string,
  _screenToken?: string,
  chainId?: number,
): Promise<ComplianceRoots> {
  void _aspUrl;
  void _screenToken;
  const r = await proxyGet("/api/asp-set/root", chainId);
  return { admittedRoot: String(r.admittedRoot), revokedRoot: String(r.revokedRoot) };
}

/**
 * Load ASP inclusion + SMT non-inclusion paths for each label, plus current roots.
 */
export async function loadComplianceWitnessMulti(
  _aspUrl?: string,
  _screenToken?: string,
  labels: string[] = [],
  opts?: { requireAdmittedPath?: boolean; chainId?: number },
): Promise<ComplianceWitness> {
  if (!labels || labels.length === 0) {
    throw new Error("loadComplianceWitnessMulti: labels required");
  }
  const inputs = await Promise.all(
    labels.map(async (label): Promise<InputCompliance> => {
      const q = encodeURIComponent(label);
      const [admitted, smt] = await Promise.all([
        proxyGet(`/api/asp-set/path?label=${q}`, opts?.chainId),
        proxyGet(`/api/asp-set/smt-path?label=${q}`, opts?.chainId),
      ]);
      // RAGEQUIT is the one action that must work WITHOUT ASP inclusion — PROTOCOL.md §5.2 lists
      // "label not in the current ASP" as its typical case, and ragequit.circom consumes no
      // admitted path at all. Demanding one here failed the only live ragequit path.
      const admittedMissing = admitted.found === false;
      if (admittedMissing && opts?.requireAdmittedPath !== false) {
        throw new Error(
          `asp path: label ${label} not member` +
            (opts?.chainId === 900002
              ? " — deposit was never admitted into solasp (watcher/postman). Retry withdraw to auto-heal, or redeploy solasp with /solana/admit-deposit."
              : ""),
        );
      }
      // Zeros at the same depth as the SMT path: the caller that opts out discards these, and a
      // right-shaped placeholder cannot be mistaken for a real path if one ever reads them.
      const zeroDepth = strArr(smt.pathElements).length;
      return {
        inLabel: String(label),
        admittedLeafIndex: admittedMissing ? 0 : Number(admitted.leafIndex ?? 0),
        admittedPathElements: admittedMissing ? new Array(zeroDepth).fill("0") : strArr(admitted.pathElements),
        admittedPathIndices: admittedMissing ? new Array(zeroDepth).fill(0) : numArr(admitted.pathIndices),
        revokedSmtPathElements: strArr(smt.pathElements),
        revokedSmtPathIndices: numArr(smt.pathIndices),
        revokedSmtLeaf: String(smt.claimedLeaf ?? "0"),
      };
    }),
  );
  const roots = await fetchComplianceRoots(undefined, undefined, opts?.chainId);
  return { admittedRoot: roots.admittedRoot, revokedRoot: roots.revokedRoot, inputs };
}

/**
 * Raw ASP membership for a label: `{admitted, revoked}` as the set reports them.
 *
 * checkAdmitted() collapses both into one boolean, which loses the distinction screening needs —
 * "not admitted yet" (still in the bus, normal after a deposit) and "revoked" (compliance
 * rejection, recoverable only by ragequit) are different states with different UI and different
 * user action. Returns null when the ASP cannot be reached, so callers can decline to claim a
 * state rather than showing a wrong one.
 */
type MemberStatus = { admitted: boolean; revoked: boolean };

/**
 * Per-label membership cache.
 *
 * /set/member answers ONE label per request and is rate limited twice over — 30/60s at the Next
 * proxy and again inside the ASP itself. Screening asks about every note the wallet holds, so an
 * 8-note wallet spent 8 requests per sweep and tripped both limiters; every 429 became `null`,
 * null means "say nothing", and the screening list came back empty. That inversion hid the In
 * Review row and its ragequit button on precisely the wallets that had pending notes.
 *
 * The asymmetry that makes caching safe: a PENDING label is the one that changes soon (the admit
 * bus runs every ~5 min), while an ADMITTED label only ever changes on revocation, which is rare.
 * So pending labels are re-asked often and admitted ones seldom. A wallet with one pending note
 * among eight then costs one request per sweep instead of eight.
 *
 * Sits in aspMemberStatus rather than in a caller because every consumer routes through here —
 * screening, the dashboard's In Review figure, and checkAdmitted on the arming path all share it.
 */
const memberCache = new Map<string, { status: MemberStatus; at: number }>();
/** Pending is volatile: the admit bus can flip it within minutes, so keep asking. */
const PENDING_TTL_MS = 20_000;
/** Admitted only changes on a revoke, which is rare and not time-critical to display. */
const ADMITTED_TTL_MS = 5 * 60_000;

/**
 * How long a membership answer stays fresh. Exported pure so the asymmetry can be tested: getting
 * it backwards would either hammer the limiter (short TTL on everything) or freeze a note in
 * "In Review" long after admission (long TTL on everything).
 */
export function memberTtlMs(
  status: MemberStatus,
  pendingTtl = PENDING_TTL_MS,
  admittedTtl = ADMITTED_TTL_MS,
): number {
  return status.admitted && !status.revoked ? admittedTtl : pendingTtl;
}

function memberCacheKey(label: string, chainId?: number): string {
  return `${chainId ?? "default"}:${label}`;
}

function cachedStatus(label: string, chainId?: number): MemberStatus | null {
  const hit = memberCache.get(memberCacheKey(label, chainId));
  if (!hit) return null;
  return Date.now() - hit.at < memberTtlMs(hit.status) ? hit.status : null;
}

/** Drop the cache — after a ragequit, or on a wallet/chain switch. */
export function clearMemberCache(): void {
  memberCache.clear();
}

export async function aspMemberStatus(
  label?: string,
  chainId?: number,
): Promise<MemberStatus | null> {
  if (!label) return null;
  const key = memberCacheKey(label, chainId);
  const fresh = cachedStatus(label, chainId);
  if (fresh) return fresh;
  try {
    const r = await proxyGet(`/api/asp-set/member?label=${encodeURIComponent(label)}`, chainId);
    const status: MemberStatus = { admitted: r.admitted === true, revoked: r.revoked === true };
    memberCache.set(key, { status, at: Date.now() });
    return status;
  } catch {
    // A rate limited read is backpressure, not evidence. Serve the last known answer even past its
    // TTL rather than returning null — null empties the screening list, which reads to the user as
    // "everything is admitted" and is the opposite of what a 429 actually tells us.
    return memberCache.get(key)?.status ?? null;
  }
}

export async function checkAdmitted(
  _aspUrl?: string,
  _screenToken?: string,
  label?: string,
  chainId?: number,
): Promise<boolean | null> {
  if (!label) return null;
  // Same cache as aspMemberStatus: the arming path shares the /set/member budget with screening,
  // and asking twice for one label is what pushed both over the limit.
  const s = await aspMemberStatus(label, chainId);
  if (!s) return null;
  return s.revoked ? false : s.admitted;
}

export async function waitForSpendablePath(
  _aspUrl?: string,
  _screenToken?: string,
  label?: string,
  opts: { timeoutMs?: number; onWait?: (secondsWaited: number) => void; chainId?: number } = {},
): Promise<{ ok: true } | { ok: false; reason: "not_member" | "publish_pending" | "unreachable" }> {
  if (!label) return { ok: false, reason: "unreachable" };
  const timeoutMs = opts.timeoutMs ?? 7 * 60_000;
  const started = Date.now();
  let last: "not_member" | "publish_pending" | "unreachable" = "unreachable";

  for (let attempt = 0; Date.now() - started < timeoutMs; attempt++) {
    try {
      const signer = await resolveSigner();
      if (!signer) return { ok: false, reason: "unreachable" };
      const res = await fetchWithWalletAuth(
        signer,
        withChainId(`/api/asp-set/path?label=${encodeURIComponent(label)}`, opts.chainId),
        { method: "GET" },
      );
      if (res.ok) {
        const data = (await res.json()) as { found?: boolean; error?: string };
        if (data.found !== false && !data.error) return { ok: true };
        const err = String(data.error || "");
        last = err.includes("publish")
          ? "publish_pending"
          : err.includes("root_check")
            ? "unreachable"
            : "not_member";
      } else {
        last = res.status === 503 ? "publish_pending" : res.status === 404 ? "not_member" : "unreachable";
      }
    } catch {
      last = "unreachable";
    }
    if (attempt > 0) opts.onWait?.(Math.round((Date.now() - started) / 1000));
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return { ok: false, reason: last };
}
