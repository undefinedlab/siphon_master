/**
 * Hard ASP client helpers — fetch association-set root / Merkle path for dual-inclusion proofs.
 * Browser calls same-origin proxies with Siphon wallet auth (asp-set routes hold ASP_SCREEN_TOKEN).
 *
 * Short in-memory response cache avoids hammering asp-set/path on every dash reconcile;
 * auth signatures are separately memory-cached in walletAuthHeaders (OMEGA-01 binding intact).
 */
import type { Signer } from "ethers";
import { fetchWithWalletAuth } from "./walletAuthHeaders";

export type AspMerklePath = {
  root: string;
  leafIndex: number;
  pathElements: string[];
  pathIndices: number[];
};

type Cached<T> = { value: T; expiresAtMs: number };

const ROOT_TTL_MS = 30_000;
/** Pending labels re-check often; admitted paths are stable longer. */
const PATH_MISS_TTL_MS = 8_000;
const PATH_HIT_TTL_MS = 60_000;

let rootCache: Cached<{ root: string; size: number } | null> | null = null;
const pathCache = new Map<string, Cached<AspMerklePath | null>>();

export function clearAspClientCache(): void {
  rootCache = null;
  pathCache.clear();
}

async function resolveSigner(): Promise<Signer | null> {
  try {
    const { getSigner } = await import("./nexus");
    return getSigner() ?? null;
  } catch {
    return null;
  }
}

export async function fetchAspRoot(): Promise<{ root: string; size: number } | null> {
  const now = Date.now();
  if (rootCache && rootCache.expiresAtMs > now) return rootCache.value;
  try {
    const signer = await resolveSigner();
    if (!signer) return null;
    const res = await fetchWithWalletAuth(signer, "/api/asp-set/root", { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as { root?: string; size?: number };
    if (!data.root) return null;
    const value = { root: data.root, size: Number(data.size ?? 0) };
    rootCache = { value, expiresAtMs: now + ROOT_TTL_MS };
    return value;
  } catch {
    return null;
  }
}

export async function fetchAspPath(label: string): Promise<AspMerklePath | null> {
  const key = String(label || "").trim();
  if (!key) return null;
  const now = Date.now();
  const hit = pathCache.get(key);
  if (hit && hit.expiresAtMs > now) return hit.value;
  try {
    const signer = await resolveSigner();
    if (!signer) return null;
    const res = await fetchWithWalletAuth(
      signer,
      `/api/asp-set/path?label=${encodeURIComponent(key)}`,
      { method: "GET" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      found?: boolean;
      root?: string;
      leafIndex?: number;
      pathElements?: string[];
      pathIndices?: number[];
    };
    if (!data.found || !data.root || !data.pathElements || !data.pathIndices) {
      pathCache.set(key, { value: null, expiresAtMs: now + PATH_MISS_TTL_MS });
      return null;
    }
    const value: AspMerklePath = {
      root: data.root,
      leafIndex: Number(data.leafIndex ?? 0),
      pathElements: data.pathElements,
      pathIndices: data.pathIndices,
    };
    pathCache.set(key, { value, expiresAtMs: now + PATH_HIT_TTL_MS });
    return value;
  } catch {
    return null;
  }
}

/** Notify ASP to auto-admit a child label — disabled in browser (postman-only). */
export async function admitAspChild(_args: {
  label: string;
  parents: string[];
  commitment?: string;
  chainId?: number;
  asset?: string;
}): Promise<boolean> {
  // Hard ASP: never call postman mutations from the client.
  console.warn("[aspClient] admitAspChild disabled — postman admits via on-chain ChangeLabeled");
  return false;
}
