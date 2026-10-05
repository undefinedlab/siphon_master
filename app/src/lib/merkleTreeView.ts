/**
 * Incremental-Merkle authentication paths for Siphon's depth-32 Poseidon tree.
 *
 * Matches on-chain `MerkleTree.sol` + Circom `MerkleTreeChecker`:
 *   - zeros[0] = 0; zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
 *   - incomplete pairs pad with zeros[level]
 *   - pathIndex 0 = current left / sibling right; 1 = sibling left / current right
 *
 * Build once from an ordered leaf snapshot (O(n)), then extract paths in O(depth).
 * Never trust a leaf set for proving without checking `root` against on-chain
 * `getRoot()` / `rootExists()` — size match alone is not integrity.
 */

export const MERKLE_TREE_DEPTH = 32;

export type Poseidon2 = (left: bigint, right: bigint) => bigint;

export interface MerklePath {
  pathElements: bigint[];
  pathIndices: number[];
}

export class MerkleTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MerkleTreeError";
  }
}

/** Precompute the 32 zero-subtree hashes used by MerkleTree.sol. */
export function computeMerkleZeros(hash: Poseidon2, depth = MERKLE_TREE_DEPTH): bigint[] {
  if (depth < 1 || depth > 64) {
    throw new MerkleTreeError(`invalid merkle depth ${depth}`);
  }
  const zeros: bigint[] = new Array(depth);
  zeros[0] = 0n;
  for (let i = 1; i < depth; i++) {
    zeros[i] = hash(zeros[i - 1], zeros[i - 1]);
  }
  return zeros;
}

/** Empty-tree root: Poseidon(zeros[depth-1], zeros[depth-1]) — matches MerkleTree constructor. */
export function emptyMerkleRoot(zeros: readonly bigint[], hash: Poseidon2): bigint {
  if (zeros.length < 1) throw new MerkleTreeError("zeros empty");
  const z = zeros[zeros.length - 1];
  return hash(z, z);
}

/**
 * Immutable view of one leaf snapshot. Levels[0] = leaves; levels[depth] = [root]
 * (or empty-root when there are no leaves).
 */
export class MerkleTreeView {
  readonly depth: number;
  readonly zeros: readonly bigint[];
  readonly leaves: readonly bigint[];
  /** levels[d][i] = node at depth d, index i. levels[0] is the leaf layer. */
  private readonly levels: readonly (readonly bigint[])[];
  readonly root: bigint;

  private constructor(
    depth: number,
    zeros: readonly bigint[],
    leaves: readonly bigint[],
    levels: readonly (readonly bigint[])[],
    root: bigint,
  ) {
    this.depth = depth;
    this.zeros = zeros;
    this.leaves = leaves;
    this.levels = levels;
    this.root = root;
  }

  static fromLeaves(
    leaves: readonly bigint[],
    hash: Poseidon2,
    opts?: { depth?: number; zeros?: readonly bigint[] },
  ): MerkleTreeView {
    const depth = opts?.depth ?? MERKLE_TREE_DEPTH;
    if (depth !== MERKLE_TREE_DEPTH) {
      // Protocol is fixed at 32; allow override only for tests with explicit zeros.
      if (!opts?.zeros || opts.zeros.length !== depth) {
        throw new MerkleTreeError(`depth ${depth} requires explicit zeros of that length`);
      }
    }
    const zeros = opts?.zeros ?? computeMerkleZeros(hash, depth);
    if (zeros.length !== depth) {
      throw new MerkleTreeError(`zeros length ${zeros.length} !== depth ${depth}`);
    }
    if (zeros[0] !== 0n) {
      throw new MerkleTreeError("zeros[0] must be 0 (MerkleTree.sol)");
    }
    for (let i = 1; i < depth; i++) {
      const expect = hash(zeros[i - 1], zeros[i - 1]);
      if (zeros[i] !== expect) {
        throw new MerkleTreeError(`zeros[${i}] inconsistent with Poseidon`);
      }
    }

    const maxLeaves = 2 ** depth;
    if (leaves.length > maxLeaves) {
      throw new MerkleTreeError(`leaf count ${leaves.length} exceeds tree capacity 2^${depth}`);
    }
    for (let i = 0; i < leaves.length; i++) {
      const v = leaves[i];
      if (typeof v !== "bigint") {
        throw new MerkleTreeError(`leaf[${i}] is not bigint`);
      }
    }

    if (leaves.length === 0) {
      const root = emptyMerkleRoot(zeros, hash);
      return new MerkleTreeView(depth, zeros, [], [[]], root);
    }

    const levels: bigint[][] = new Array(depth + 1);
    levels[0] = leaves.slice();
    for (let level = 0; level < depth; level++) {
      const cur = levels[level];
      const next: bigint[] = [];
      for (let i = 0; i < cur.length; i += 2) {
        const left = cur[i];
        const right = i + 1 < cur.length ? cur[i + 1] : zeros[level];
        next.push(hash(left, right));
      }
      // A non-empty tree must produce at least one node each level (single leaf pads with zero).
      if (next.length === 0) {
        throw new MerkleTreeError(`internal error: empty level ${level + 1}`);
      }
      levels[level + 1] = next;
    }
    if (levels[depth].length !== 1) {
      throw new MerkleTreeError(
        `internal error: expected single root, got ${levels[depth].length} nodes at depth ${depth}`,
      );
    }
    return new MerkleTreeView(depth, zeros, levels[0], levels, levels[depth][0]);
  }

  get size(): number {
    return this.leaves.length;
  }

  leafAt(index: number): bigint {
    this.assertLeafIndex(index);
    return this.leaves[index];
  }

  /**
   * Authentication path for `leafIndex`. O(depth) using cached levels — must match
   * Circom MerkleTreeChecker / legacy full-rebuild path bit-for-bit.
   */
  path(leafIndex: number): MerklePath {
    this.assertLeafIndex(leafIndex);
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let idx = leafIndex;
    for (let level = 0; level < this.depth; level++) {
      const isRight = idx % 2;
      pathIndices.push(isRight);
      const siblingIdx = isRight === 1 ? idx - 1 : idx + 1;
      const layer = this.levels[level];
      pathElements.push(siblingIdx < layer.length ? layer[siblingIdx] : this.zeros[level]);
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  }

  /** Fold `leaf` up `path`; must equal `this.root` for a valid membership witness. */
  fold(leaf: bigint, path: MerklePath, hash: Poseidon2): bigint {
    if (path.pathElements.length !== this.depth || path.pathIndices.length !== this.depth) {
      throw new MerkleTreeError(
        `path length ${path.pathElements.length}/${path.pathIndices.length} !== depth ${this.depth}`,
      );
    }
    let cur = leaf;
    for (let i = 0; i < this.depth; i++) {
      const sib = path.pathElements[i];
      const bit = path.pathIndices[i];
      if (bit !== 0 && bit !== 1) {
        throw new MerkleTreeError(`pathIndices[${i}] must be 0 or 1, got ${bit}`);
      }
      cur = bit === 0 ? hash(cur, sib) : hash(sib, cur);
    }
    return cur;
  }

  /** True iff leaf at index folds to this snapshot root along its path. */
  verifyIndex(leafIndex: number, hash: Poseidon2): boolean {
    const leaf = this.leafAt(leafIndex);
    const p = this.path(leafIndex);
    return this.fold(leaf, p, hash) === this.root;
  }

  private assertLeafIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.leaves.length) {
      throw new MerkleTreeError(
        `leafIndex ${index} out of range for snapshot size ${this.leaves.length}`,
      );
    }
  }
}

/**
 * Strict gate before proving: snapshot root must be the live root, or an historical
 * root the vault still accepts (`knownRoots` / rootExists).
 *
 * Returns the root to bind as the circuit `stateRoot` public signal.
 */
export async function assertUsableMerkleRoot(
  snapshotRoot: bigint,
  liveRoot: bigint,
  rootExists: (root: bigint) => Promise<boolean>,
): Promise<bigint> {
  if (snapshotRoot === liveRoot) return snapshotRoot;
  let known: boolean;
  try {
    known = await rootExists(snapshotRoot);
  } catch (err) {
    throw new MerkleTreeError(
      `leaf snapshot root differs from live getRoot() and rootExists() failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!known) {
    throw new MerkleTreeError(
      "leaf snapshot is not a known on-chain root (gapped/reordered/corrupt leaves) — refresh and retry",
    );
  }
  return snapshotRoot;
}
