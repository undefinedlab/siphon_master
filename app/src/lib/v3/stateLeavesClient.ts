/**
 * v3 state-leaf client — fetches the ordered NoteTree leaf list from the indexer's `/state/leaves`.
 *
 * Gated on the `NoteTree.CommitmentInserted` emit + `INDEX_STATE_LEAVES=1` (siphon-indexer-v2
 * PHASE-B-STATE-LEAVES.md). Until the contract is redeployed with the event, `/state/leaves`
 * returns 503 — this client surfaces that as {available:false} so callers fail closed with a clear
 * message instead of building a stale tree.
 *
 * Returns the FULL ordered leaf list (one state tree, not per-asset); the client rebuilds sibling
 * paths itself (see stateTreeV3).
 *
 * Caching: successful snapshots are kept in-memory per chain and reused while the on-chain
 * `stateRoot()` is unchanged. Concurrent callers share one in-flight fetch. Chain-scan fallbacks
 * are incremental from the last verified tip block so a second withdraw does not re-walk the
 * entire deploy→head getLogs range (that path is what 429'd free-tier RPCs on retry).
 */

import { ethers } from "ethers";
import { v3Config } from "./configV3";

export interface StateLeaves {
  /** Commitments in insertion order; index i == leafIndex i. */
  leaves: bigint[];
  /** The tree root the indexer reports for this leaf set (for a fast freshness cross-check). */
  root: bigint | null;
  /** Highest leafIndex + 1 (== leaves.length when fully paged). */
  count: number;
}

export interface StateLeavesResult {
  available: boolean;
  reason?: string;
  data?: StateLeaves;
}

export interface WaitForStateLeafOptions {
  /** Total snapshots to try before surfacing a retryable indexing error. */
  attempts?: number;
  /** Delay between snapshots. */
  delayMs?: number;
  /** Deterministic test seam; production always uses fetchStateLeaves. */
  fetchSnapshot?: (chainId: number) => Promise<StateLeavesResult>;
}

const PAGE_LIMIT = 500; // indexer MAX_PAGE (F-3)

/** Successful snapshot — reused while on-chain stateRoot matches. */
type SnapshotCache = {
  result: StateLeavesResult;
  root: bigint;
  tipBlock: number;
};

/** Incremental chain-scan checkpoint (even mid-session after a verified scan). */
type ChainScanCheckpoint = {
  leaves: bigint[];
  root: bigint;
  tipBlock: number;
};

const snapshotCache = new Map<number, SnapshotCache>();
const snapshotInflight = new Map<number, Promise<StateLeavesResult>>();
const chainScanCheckpoint = new Map<number, ChainScanCheckpoint>();

/** Drop cached snapshots (e.g. after a successful spend that inserts a change note). */
export function invalidateStateLeavesCache(chainId?: number): void {
  if (chainId == null) {
    snapshotCache.clear();
    snapshotInflight.clear();
    return;
  }
  snapshotCache.delete(chainId);
  snapshotInflight.delete(chainId);
}

function toBig(x: unknown): bigint | null {
  try {
    if (typeof x === "bigint") return x;
    if (typeof x === "number") return BigInt(x);
    if (typeof x === "string" && x.length > 0) return BigInt(x);
  } catch {
    /* fallthrough */
  }
  return null;
}

/** Normalize one indexer page and prove it is contiguous from `expectedStart`. */
export function normalizeStateLeafPage(
  page: unknown[],
  expectedStart: number,
): { leaves: bigint[] } | { error: string } {
  const indexed = page.map((item, offset) => {
    if (typeof item !== "object" || item === null) {
      const leaf = toBig(item);
      return leaf === null ? null : { index: expectedStart + offset, leaf };
    }
    const row = item as Record<string, unknown>;
    const leaf = toBig(row.commitment);
    const index = Number(row.leafIndex);
    return leaf === null || !Number.isSafeInteger(index) || index < 0 ? null : { index, leaf };
  });
  if (indexed.some((item) => item === null)) return { error: "malformed leaf entry" };
  const ordered = (indexed as Array<{ index: number; leaf: bigint }>).sort((a, b) => a.index - b.index);
  const gap = ordered.findIndex((item, offset) => item.index !== expectedStart + offset);
  if (gap !== -1) {
    return {
      error: `state leaf index mismatch: expected ${expectedStart + gap}, got ${ordered[gap].index}`,
    };
  }
  return { leaves: ordered.map((item) => item.leaf) };
}

/** Optional test overrides — production leaves these unset. */
let testReadOnChainStateRoot: ((chainId: number) => Promise<bigint | null>) | null = null;

/** @internal */
export function setStateLeavesTestHooks(hooks: {
  readOnChainStateRoot?: ((chainId: number) => Promise<bigint | null>) | null;
}): void {
  testReadOnChainStateRoot = hooks.readOnChainStateRoot ?? null;
}

async function readOnChainStateRoot(chainId: number): Promise<bigint | null> {
  if (testReadOnChainStateRoot) return testReadOnChainStateRoot(chainId);
  const cfg = v3Config(chainId);
  if (!cfg?.vaultKernel) return null;
  try {
    const { getReadProvider } = await import("../zkHandler");
    const kernel = new ethers.Contract(
      cfg.vaultKernel,
      ["function stateRoot() external view returns (uint256)"],
      getReadProvider(chainId),
    );
    return BigInt((await kernel.stateRoot()).toString());
  } catch {
    return null;
  }
}

/**
 * Fetch the full ordered state-leaf list for `chainId`, paging until exhausted.
 * @returns {available:false} on 503 (emit not deployed) or any network error.
 */
export async function fetchStateLeaves(chainId: number): Promise<StateLeavesResult> {
  const cached = snapshotCache.get(chainId);
  if (cached?.result.available && cached.result.data) {
    const liveRoot = await readOnChainStateRoot(chainId);
    if (liveRoot !== null && liveRoot === cached.root) {
      return cached.result;
    }
    // Tip moved (or root unreadable) — drop and refetch.
    snapshotCache.delete(chainId);
  }

  const pending = snapshotInflight.get(chainId);
  if (pending) return pending;

  const task = fetchStateLeavesUncached(chainId).then((result) => {
    if (result.available && result.data?.root != null) {
      const tipBlock = chainScanCheckpoint.get(chainId)?.tipBlock ?? 0;
      snapshotCache.set(chainId, {
        result,
        root: result.data.root,
        tipBlock,
      });
    }
    return result;
  }).finally(() => {
    snapshotInflight.delete(chainId);
  });

  snapshotInflight.set(chainId, task);
  return task;
}

async function fetchStateLeavesUncached(chainId: number): Promise<StateLeavesResult> {
  const cfg = v3Config(chainId);
  if (!cfg) return { available: false, reason: `unsupported chain ${chainId}` };
  if (!cfg.indexerUrl) return leavesFromChain(chainId);

  // An indexer that answers but has nothing for this chain must not be worse than no indexer at
  // all. Base runs exactly that shape: the deployment indexes Sepolia only, so /state/leaves
  // returns 503 commitment_inserted_event_required with totalCount 0. While Base had no indexer
  // URL configured the line above sent it down the chain scan and v3 worked; the moment a URL was
  // set, every v3 path on Base — arming, withdraw, output-note resolution — died on "state leaves
  // unavailable" instead. Configuring a service should not be able to take the product down.
  //
  // Falling back is safe because leavesFromChain is VERIFIED, not trusted: it rebuilds from
  // NoteTree.CommitmentInserted (every leaf, whatever inserted it) and refuses unless the rebuilt
  // root equals the kernel's on-chain stateRoot(). A wrong or partial scan fails closed, so the
  // worst case here is the same error as before, never a bad Merkle path.
  const viaChain = async (indexerReason: string): Promise<StateLeavesResult> => {
    const scan = await leavesFromChain(chainId);
    if (scan.available) return scan;
    return { available: false, reason: `${indexerReason}; chain-scan fallback: ${scan.reason}` };
  };

  const leaves: bigint[] = [];
  let root: bigint | null = null;
  let totalCount: number | null = null;
  let from = 0;

  // Page through /state/leaves?chainId=&fromIndex=&limit= until fewer than a full page returns.
  //
  // The parameter names are the indexer's, not ours (siphon-indexer-v2 src/api/index.ts): `chainId`
  // is REQUIRED and answers 400 without it, and the cursor is `fromIndex`. This client previously
  // sent `?from=` with no chainId, so every call 400'd and the whole v3 arming path silently fell
  // back to the deposit-only chain scan — which fails closed the moment a split inserts a note.
  for (let guard = 0; guard < 10_000; guard++) {
    const url =
      `${cfg.indexerUrl}/state/leaves?chainId=${chainId}&fromIndex=${from}&limit=${PAGE_LIMIT}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return viaChain("indexer unreachable");
    }
    if (res.status === 503) {
      return viaChain("state leaves not indexed (CommitmentInserted emit / INDEX_STATE_LEAVES pending)");
    }
    if (!res.ok) {
      return viaChain(`indexer ${res.status}`);
    }

    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return viaChain("malformed indexer response");
    }

    const page = Array.isArray(body.leaves) ? (body.leaves as unknown[]) : null;
    if (!page) return viaChain("response missing leaves[]");
    // The indexer calls this `tipRoot` (the root emitted with its newest leaf). The old client read
    // `body.root`, which does not exist, so it silently threw away the only freshness signal the
    // response carries.
    const pageTipRoot = toBig(body.tipRoot ?? body.root);
    const pageTotal = Number(body.totalCount);
    if (!Number.isSafeInteger(pageTotal) || pageTotal < 0 || pageTipRoot === null) {
      return viaChain("response missing totalCount/tipRoot");
    }
    if (totalCount === null) {
      totalCount = pageTotal;
      root = pageTipRoot;
    } else if (pageTotal !== totalCount || pageTipRoot !== root) {
      // The append-only tree advanced while it was being paged. Mixing pages from two tips can
      // still look contiguous while rebuilding a root that never existed.
      return viaChain("indexer tip changed while paging");
    }

    // Object rows carry the authoritative leafIndex. Sort by it and require contiguity rather
    // than trusting database row order; a plausible-but-permuted leaf list rebuilds the wrong tree.
    const normalized = normalizeStateLeafPage(page, leaves.length);
    if ("error" in normalized) return viaChain(normalized.error);
    leaves.push(...normalized.leaves);

    if (page.length < PAGE_LIMIT) break;
    from += PAGE_LIMIT;
  }

  if (totalCount === null || root === null || leaves.length !== totalCount) {
    return viaChain(
      `indexer snapshot incomplete (${leaves.length}/${totalCount === null ? "unknown" : totalCount})`,
    );
  }

  // A 200 is not a freshness guarantee. Immediately after MERGE the transaction is mined (and the
  // new note is already persisted locally) several seconds before the indexer ingests its
  // CommitmentInserted event. Accepting that stale-but-well-formed list makes the next WITHDRAW
  // fail with "note not in state leaves". Compare the indexer's emitted tip root to the kernel's
  // live root and use the verified chain scan when they differ.
  try {
    const onChainRoot = await readOnChainStateRoot(chainId);
    if (onChainRoot === null) {
      return viaChain("could not verify indexer state root");
    }
    if (root !== onChainRoot) {
      return viaChain("indexer state root is stale");
    }
  } catch (e) {
    return viaChain(`could not verify indexer state root: ${(e as Error).message}`);
  }

  return { available: true, data: { leaves, root, count: leaves.length } };
}

/**
 * Wait until a just-mined output note is available for the next proof.
 *
 * MERGE/SPLIT return only after their transaction receipt, but the read RPC and indexer may trail
 * the relayer RPC by a few seconds. The output note is safe (its secrets are persisted before this
 * is called); this bounded wait only prevents an immediate follow-up from selecting it before a
 * sibling path can be reconstructed.
 */
export async function waitForStateLeaf(
  chainId: number,
  commitment: string | bigint,
  options: WaitForStateLeafOptions = {},
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 6);
  const delayMs = Math.max(0, options.delayMs ?? 1_000);
  const fetchSnapshot = options.fetchSnapshot ?? fetchStateLeaves;
  const wanted = BigInt(commitment);
  let lastReason = "leaf absent from the latest verified snapshot";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // A just-mined leaf changes the on-chain root — drop the snapshot so we do not keep serving
    // the pre-merge tree for the whole poll window.
    if (attempt > 1) invalidateStateLeavesCache(chainId);
    const snapshot = await fetchSnapshot(chainId);
    if (snapshot.available && snapshot.data) {
      if (snapshot.data.leaves.some((leaf) => leaf === wanted)) return;
      lastReason = `leaf absent from verified ${snapshot.data.count}-leaf snapshot`;
    } else {
      lastReason = snapshot.reason ?? "state leaves unavailable";
    }

    if (attempt < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    `The consolidation succeeded, but its new private note is still syncing (${lastReason}). ` +
      `Your funds are safe; retry the withdrawal in a few seconds.`,
  );
}

/**
 * Indexer-free fallback: rebuild the leaf list from NoteTree.CommitmentInserted.
 *
 * Verified, not trusted: the reconstructed root must equal the kernel's on-chain stateRoot().
 * Incremental: after one verified scan, later calls only query from the last tip block.
 */
async function leavesFromChain(chainId: number): Promise<StateLeavesResult> {
  const cfg = v3Config(chainId);
  if (!cfg) return { available: false, reason: `unsupported chain ${chainId}` };
  if (!cfg.deployBlock) {
    return { available: false, reason: "no indexer URL and no deployBlock to scan from" };
  }

  try {
    const { getReadProvider, getLogsChunked } = await import("../zkHandler");
    const { computeStateRoot } = await import("./stateTreeV3");
    const provider = getReadProvider(chainId);

    const kernel = new ethers.Contract(
      cfg.vaultKernel,
      [
        "function notes() external view returns (address)",
        "function stateRoot() external view returns (uint256)",
      ],
      provider,
    );

    const noteTreeAddr: string = await kernel.notes();
    const latest = await provider.getBlockNumber();
    const onChain = BigInt((await kernel.stateRoot()).toString());

    const prior = chainScanCheckpoint.get(chainId);
    // Same tip → return the verified checkpoint with zero getLogs.
    if (prior && prior.root === onChain) {
      return {
        available: true,
        data: { leaves: prior.leaves, root: onChain, count: prior.leaves.length },
      };
    }

    const insertedTopic = ethers.id("CommitmentInserted(uint256,uint256,uint256)");
    const fromBlock = prior ? Math.max(cfg.deployBlock, prior.tipBlock) : cfg.deployBlock;
    const logs = await getLogsChunked(
      provider,
      { address: noteTreeAddr, topics: [insertedTopic] },
      fromBlock,
      latest,
    );

    const iface = new ethers.Interface([
      "event CommitmentInserted(uint256 indexed leafIndex, uint256 commitment, uint256 newRoot)",
    ]);

    type LeafRow = { index: number; leaf: bigint; blockNumber: number };
    const decoded: LeafRow[] = [];
    for (const log of logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!parsed) continue;
        decoded.push({
          index: Number(parsed.args.leafIndex),
          leaf: BigInt(parsed.args.commitment),
          blockNumber: log.blockNumber,
        });
      } catch {
        /* skip undecodable */
      }
    }

    let ordered: LeafRow[];
    if (prior && prior.root !== onChain) {
      // Append only new indices; re-fetch overlapping tipBlock can duplicate the last leaf.
      const byIndex = new Map<number, LeafRow>();
      prior.leaves.forEach((leaf, index) => {
        byIndex.set(index, { index, leaf, blockNumber: prior.tipBlock });
      });
      for (const row of decoded) byIndex.set(row.index, row);
      ordered = [...byIndex.values()].sort((a, b) => a.index - b.index);
    } else {
      ordered = decoded.sort((a, b) => a.index - b.index);
    }

    const missing = ordered.findIndex((x, i) => x.index !== i);
    if (missing !== -1) {
      // Checkpoint is corrupt or a log was missed — wipe and force a full rescan next time.
      chainScanCheckpoint.delete(chainId);
      return {
        available: false,
        reason: `state leaf ${missing} missing from the chain scan (got index ${ordered[missing].index})`,
      };
    }

    const leaves = ordered.map((x) => x.leaf);
    const rebuilt = await computeStateRoot(leaves);

    if (rebuilt !== onChain) {
      chainScanCheckpoint.delete(chainId);
      return {
        available: false,
        reason:
          "reconstructed state tree does not match the on-chain root — the scan is incomplete " +
          "or a leaf was missed; refusing to build paths against it",
      };
    }

    const tipBlock = ordered.length > 0
      ? Math.max(...ordered.map((x) => x.blockNumber))
      : latest;

    chainScanCheckpoint.set(chainId, { leaves, root: onChain, tipBlock });

    return { available: true, data: { leaves, root: onChain, count: leaves.length } };
  } catch (e) {
    return { available: false, reason: `chain scan failed: ${(e as Error).message}` };
  }
}
