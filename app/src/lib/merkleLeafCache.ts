/**
 * Incremental merkle-leaf sync (P1).
 *
 * Privacy: only public LeafInserted data — never asks the server which leaf the user spends.
 * Security: never append a non-contiguous page; verify tipRoot / folded root against chain;
 *           clear cache on tree-address change, gap, or root mismatch.
 *
 * Persistence uses localStorage (best-effort). Quota failures fall back to memory-only so UX
 * still benefits within the session. This is NOT the old lastBlock RPC cache (that caused gaps).
 */

import { MerkleTreeView, type Poseidon2 } from "./merkleTreeView";

export const MERKLE_LEAF_CACHE_VERSION = 1;
export const MERKLE_LEAF_STORAGE_PREFIX = "siphon-merkle-leaves-v1:";

export interface LeavesPage {
  chainId: number;
  asset: string;
  fromIndex: number;
  count: number;
  totalCount: number;
  nextIndex: number;
  tipRoot: string | null;
  tipLeafIndex: number | null;
  /** Block number of the tip leaf — used for bounded RPC catch-up (P2). */
  tipBlockNumber: number | null;
  contiguous: boolean;
  leaves: string[];
}

export interface LeafCacheSnapshot {
  v: typeof MERKLE_LEAF_CACHE_VERSION;
  chainId: number;
  asset: string;
  /** MerkleTree contract address — bust cache on redeploy. */
  tree: string;
  leaves: string[];
  /** Indexer tipRoot when last saved (root after highest known leaf). */
  tipRoot: string;
  /** Block of tip leaf when known — enables P2 RPC catch-up without deploy→head. */
  tipBlock?: number;
  savedAt: number;
}

export type FetchLeavesPage = (
  chainId: number,
  asset: string,
  fromIndex: number,
) => Promise<LeavesPage | null>;

export interface ChainTreeHints {
  onChainSize: number;
  onChainRoot: bigint;
  rootExists: (root: bigint) => Promise<boolean>;
}

export type SyncLeavesResult =
  | { ok: true; leaves: bigint[]; tipRoot: bigint; fromCache: boolean; fetched: number }
  | { ok: false; reason: string };

function storageKey(chainId: number, asset: string, tree: string): string {
  return `${MERKLE_LEAF_STORAGE_PREFIX}${chainId}:${asset.toUpperCase()}:${tree.toLowerCase()}`;
}

const memory = new Map<string, LeafCacheSnapshot>();

export function clearMerkleLeafMemoryCache(chainId?: number, asset?: string, tree?: string): void {
  if (chainId === undefined) {
    memory.clear();
    return;
  }
  if (asset && tree) {
    memory.delete(storageKey(chainId, asset, tree));
    return;
  }
  const prefix = `${MERKLE_LEAF_STORAGE_PREFIX}${chainId}:`;
  for (const k of [...memory.keys()]) {
    if (k.startsWith(prefix)) memory.delete(k);
  }
}

/** Drop persisted + memory snapshots (corruption / tree change / explicit invalidate). */
export function clearMerkleLeafStore(chainId?: number, asset?: string, tree?: string): void {
  clearMerkleLeafMemoryCache(chainId, asset, tree);
  if (typeof localStorage === "undefined") return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(MERKLE_LEAF_STORAGE_PREFIX)) continue;
      if (chainId === undefined) {
        keys.push(k);
        continue;
      }
      if (asset && tree) {
        if (k === storageKey(chainId, asset, tree)) keys.push(k);
      } else if (k.startsWith(`${MERKLE_LEAF_STORAGE_PREFIX}${chainId}:`)) {
        keys.push(k);
      }
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

export function loadLeafSnapshot(
  chainId: number,
  asset: string,
  tree: string,
): LeafCacheSnapshot | null {
  const key = storageKey(chainId, asset, tree);
  const mem = memory.get(key);
  if (mem) return mem;
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LeafCacheSnapshot;
    if (
      parsed?.v !== MERKLE_LEAF_CACHE_VERSION ||
      parsed.chainId !== chainId ||
      parsed.asset.toUpperCase() !== asset.toUpperCase() ||
      parsed.tree.toLowerCase() !== tree.toLowerCase() ||
      !Array.isArray(parsed.leaves) ||
      typeof parsed.tipRoot !== "string"
    ) {
      localStorage.removeItem(key);
      return null;
    }
    memory.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function saveLeafSnapshot(snap: LeafCacheSnapshot): void {
  const key = storageKey(snap.chainId, snap.asset, snap.tree);
  memory.set(key, snap);
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(snap));
  } catch {
    // Quota / private mode — memory cache still helps this session.
  }
}

/**
 * Pure merge: append page onto base only when contiguous and fromIndex matches base length.
 * Exported for unit tests.
 */
export function appendLeavesPage(
  base: string[],
  page: LeavesPage,
): { ok: true; leaves: string[] } | { ok: false; reason: string } {
  if (!page.contiguous) {
    return { ok: false, reason: "page not contiguous" };
  }
  if (page.fromIndex !== base.length) {
    return { ok: false, reason: `fromIndex ${page.fromIndex} !== base length ${base.length}` };
  }
  if (page.leaves.length !== page.count) {
    return { ok: false, reason: "count mismatch" };
  }
  return { ok: true, leaves: base.concat(page.leaves) };
}

/**
 * Integrity gate after sync. Size may lag the chain (indexer behind); then tip/folded root
 * must still be a known historical root. Size ahead of chain = corrupt.
 */
export async function verifySyncedLeaves(
  leaves: bigint[],
  tipRootFromIndexer: bigint | null,
  hints: ChainTreeHints,
  hash: Poseidon2,
): Promise<{ ok: true; tipRoot: bigint } | { ok: false; reason: string }> {
  if (leaves.length > hints.onChainSize) {
    return { ok: false, reason: `synced ${leaves.length} leaves > on-chain size ${hints.onChainSize}` };
  }
  if (leaves.length === 0) {
    if (hints.onChainSize === 0) {
      return { ok: true, tipRoot: hints.onChainRoot };
    }
    return { ok: false, reason: "empty sync while on-chain tree non-empty" };
  }

  let folded: bigint;
  try {
    folded = MerkleTreeView.fromLeaves(leaves, hash).root;
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  if (tipRootFromIndexer !== null && tipRootFromIndexer !== folded) {
    return {
      ok: false,
      reason: "indexer tipRoot !== folded snapshot root (corrupt or gapped leaves)",
    };
  }

  if (leaves.length === hints.onChainSize) {
    if (folded !== hints.onChainRoot) {
      return {
        ok: false,
        reason: "folded root !== live getRoot() at matching size",
      };
    }
    return { ok: true, tipRoot: folded };
  }

  // Indexer (or local cache) behind head — acceptable iff historical root is known.
  try {
    const known = await hints.rootExists(folded);
    if (!known) {
      return { ok: false, reason: "lagging snapshot root not in knownRoots" };
    }
  } catch (e) {
    return {
      ok: false,
      reason: `rootExists failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { ok: true, tipRoot: folded };
}

/**
 * Sync leaves for one tree: memory/disk cache + incremental fromIndex fetch + verify.
 * On any integrity failure, clears that tree's cache and retries one full fetch (fromIndex=0).
 */
export async function syncMerkleLeaves(args: {
  chainId: number;
  asset: string;
  tree: string;
  fetchPage: FetchLeavesPage;
  hints: ChainTreeHints;
  hash: Poseidon2;
}): Promise<SyncLeavesResult> {
  const { chainId, asset, tree, fetchPage, hints, hash } = args;
  const assetKey = asset.toUpperCase();

  const attempt = async (forceFull: boolean): Promise<SyncLeavesResult> => {
    let base: string[] = [];
    let fromCache = false;

    if (!forceFull) {
      const snap = loadLeafSnapshot(chainId, assetKey, tree);
      if (snap && snap.leaves.length <= hints.onChainSize) {
        base = snap.leaves.slice();
        fromCache = true;
      }
    }

    let fetched = 0;
    let tipRootStr: string | null = null;
    let tipBlockNumber: number | null = null;
    let guard = 0;

    while (guard++ < 64) {
      const page = await fetchPage(chainId, assetKey, base.length);
      if (!page) {
        if (base.length === 0) return { ok: false, reason: "indexer unavailable" };
        break;
      }
      if (page.totalCount === 0 && base.length === 0) {
        return { ok: false, reason: "indexer empty" };
      }

      tipRootStr = page.tipRoot;
      if (page.tipBlockNumber != null && Number.isFinite(page.tipBlockNumber)) {
        tipBlockNumber = page.tipBlockNumber;
      }

      if (page.count === 0) {
        // Caught up with indexer (may still lag chain).
        break;
      }

      const merged = appendLeavesPage(base, page);
      if (!merged.ok) {
        return { ok: false, reason: merged.reason };
      }
      base = merged.leaves;
      fetched += page.count;

      // Stop when we have everything the indexer currently knows.
      if (base.length >= page.totalCount) break;
      // Or a short page without limit means EOF.
      if (page.nextIndex <= page.fromIndex) {
        return { ok: false, reason: "nextIndex did not advance" };
      }
    }

    const leaves = base.map((s) => BigInt(s));
    const tipRootFromIndexer = tipRootStr !== null ? BigInt(tipRootStr) : null;
    const verified = await verifySyncedLeaves(leaves, tipRootFromIndexer, hints, hash);
    if (!verified.ok) {
      return { ok: false, reason: verified.reason };
    }

    const prevTip = loadLeafSnapshot(chainId, assetKey, tree)?.tipBlock;
    saveLeafSnapshot({
      v: MERKLE_LEAF_CACHE_VERSION,
      chainId,
      asset: assetKey,
      tree: tree.toLowerCase(),
      leaves: base,
      tipRoot: verified.tipRoot.toString(),
      tipBlock: tipBlockNumber ?? prevTip,
      savedAt: Date.now(),
    });

    return {
      ok: true,
      leaves,
      tipRoot: verified.tipRoot,
      fromCache,
      fetched,
    };
  };

  let result = await attempt(false);
  if (!result.ok) {
    clearMerkleLeafStore(chainId, assetKey, tree);
    result = await attempt(true);
    if (!result.ok) {
      clearMerkleLeafStore(chainId, assetKey, tree);
    }
  }
  return result;
}
