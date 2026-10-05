/**
 * P2: bounded RPC catch-up for Merkle leaves.
 *
 * Prefer indexer sync (P1). When RPC is needed, scan from the last known tip block
 * (with a small overlap), NOT deploy→head — unless there is no tip (cold start / repair).
 *
 * Same-block multi-inserts: overlap re-reads recent blocks; merge keys by leaf index so
 * we never double-append. This avoids the old lastBlock+1 gap bug.
 */

export const RPC_CATCHUP_OVERLAP_BLOCKS = 64;

export interface LeafInsertedEvent {
  index: bigint;
  leaf: bigint;
  root: bigint;
  blockNumber: number;
}

export type CatchupScanPlan =
  | { mode: "catchup"; fromBlock: number }
  | { mode: "full"; fromBlock: number };

/**
 * Choose eth_getLogs fromBlock. Catch-up when we have a trusted tipBlock; otherwise full
 * history from deploy (cold / repair only).
 */
export function planLeafLogScan(opts: {
  deployBlock: number;
  latestBlock: number;
  tipBlock?: number | null;
  overlapBlocks?: number;
}): CatchupScanPlan {
  const deploy = Math.max(0, opts.deployBlock);
  const latest = Math.max(deploy, opts.latestBlock);
  const overlap = opts.overlapBlocks ?? RPC_CATCHUP_OVERLAP_BLOCKS;

  if (opts.tipBlock == null || !Number.isFinite(opts.tipBlock) || opts.tipBlock < deploy) {
    return { mode: "full", fromBlock: deploy };
  }

  const tip = Math.min(Math.floor(opts.tipBlock), latest);
  const fromBlock = Math.max(deploy, tip - overlap + 1);
  if (fromBlock <= deploy) {
    return { mode: "full", fromBlock: deploy };
  }
  return { mode: "catchup", fromBlock };
}

/**
 * Merge RPC LeafInserted events onto a dense base leaf array.
 * Only appends indices >= base.length; requires contiguous indices; tracks max block.
 */
export function mergeLeafInsertedCatchup(
  baseLeaves: readonly bigint[],
  events: readonly LeafInsertedEvent[],
): { ok: true; leaves: bigint[]; tipBlock: number } | { ok: false; reason: string } {
  const byIndex = new Map<number, LeafInsertedEvent>();
  for (const e of events) {
    if (e.index < 0n) {
      return { ok: false, reason: `negative leaf index ${e.index}` };
    }
    if (e.index > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { ok: false, reason: `leaf index ${e.index} exceeds safe integer` };
    }
    const idx = Number(e.index);
    const prev = byIndex.get(idx);
    if (prev && (prev.leaf !== e.leaf || prev.root !== e.root)) {
      return { ok: false, reason: `conflicting LeafInserted data at index ${idx}` };
    }
    byIndex.set(idx, e);
  }

  // Optional integrity: overlapping indices must match base.
  for (let i = 0; i < baseLeaves.length; i++) {
    const ev = byIndex.get(i);
    if (ev && ev.leaf !== baseLeaves[i]) {
      return {
        ok: false,
        reason: `RPC leaf at index ${i} disagrees with cached base (possible reorg/corruption)`,
      };
    }
  }

  const out = baseLeaves.slice();
  let tipBlock = 0;
  let expected = baseLeaves.length;

  // Append in order; stop at first missing index (partial catch-up window is OK if we got
  // everything up to a gap — but a hole after we've started appending is fatal).
  const pending = [...byIndex.keys()].filter((i) => i >= baseLeaves.length).sort((a, b) => a - b);
  for (const idx of pending) {
    if (idx !== expected) {
      return {
        ok: false,
        reason: `RPC catch-up gap: expected index ${expected}, got ${idx}`,
      };
    }
    const ev = byIndex.get(idx)!;
    out.push(ev.leaf);
    tipBlock = Math.max(tipBlock, ev.blockNumber);
    expected += 1;
  }

  if (out.length === baseLeaves.length && pending.length === 0) {
    // No new leaves in window — keep prior tipBlock unknown here (caller retains old tip).
    return { ok: true, leaves: out, tipBlock: 0 };
  }

  return { ok: true, leaves: out, tipBlock };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
