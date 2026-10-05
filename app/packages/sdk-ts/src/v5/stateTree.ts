/**
 * v3 state Merkle tree — client-side reconstruction (PROTOCOL §2.4, depth-32 binary Poseidon).
 *
 * v3 note commitments live in an incremental Merkle tree in `NoteTree`. The indexer serves the
 * ordered leaf list (`/state/leaves`, gated on the `CommitmentInserted` emit — see
 * siphon-indexer-v2 PHASE-B-STATE-LEAVES.md); the client rebuilds sibling paths itself. This is the
 * agreed design: the indexer stops at leaves, path reconstruction is client-side (self-validating
 * against the on-chain root, which the client fetches directly).
 *
 * Path convention (§2.4): for leaf at index `i`, level-`j` bit is bit `j` of `i` (LSB-first);
 * pathIndices[j] == 0 → node is left child (hash(node, sibling)); == 1 → right (hash(sibling, node)).
 * Empty siblings are zero, matching the on-chain `MerkleTree` / `NoteTree` convention.
 */

import { poseidon2 } from "./noteCrypto";

export const TREE_DEPTH = 32;

export interface StatePath {
  /** Sibling at each level, low→high (length TREE_DEPTH). */
  pathElements: bigint[];
  /** Direction bit at each level (0 = leaf is left child). */
  pathIndices: number[];
  /** Root the path reconstructs to. */
  root: bigint;
  /** Leaf index the path was built for. */
  leafIndex: number;
}

/** Precomputed zero-subtree roots: zeros[0]=0, zeros[k]=Poseidon(zeros[k-1],zeros[k-1]). */
async function zeroLevels(depth: number): Promise<bigint[]> {
  const zeros: bigint[] = [0n];
  for (let i = 1; i <= depth; i++) {
    zeros[i] = await poseidon2(zeros[i - 1], zeros[i - 1]);
  }
  return zeros;
}

/**
 * Reconstruct the sibling path for `leafIndex` from the ordered leaf list.
 *
 * `leaves[i]` is the commitment inserted at position `i` (the indexer's `/state/leaves` order,
 * which matches `NoteTree`'s incremental insert order). Missing trailing leaves are treated as
 * empty (zero) — an incremental tree pads the right with zero subtrees.
 *
 * @throws if leafIndex is out of range or negative.
 */
export async function buildStatePath(
  leaves: bigint[],
  leafIndex: number,
  depth: number = TREE_DEPTH,
): Promise<StatePath> {
  if (!Number.isInteger(leafIndex) || leafIndex < 0) {
    throw new Error(`buildStatePath: invalid leafIndex ${leafIndex}`);
  }
  if (leafIndex >= leaves.length) {
    throw new Error(
      `buildStatePath: leafIndex ${leafIndex} out of range (have ${leaves.length} leaves)`,
    );
  }

  const zeros = await zeroLevels(depth);
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];

  // Current level is the full leaf list; walk up, recording the sibling of the tracked node.
  let level: bigint[] = leaves.slice();
  let idx = leafIndex;

  for (let d = 0; d < depth; d++) {
    const isRight = idx & 1; // node is right child when its index is odd
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const sibling = siblingIdx < level.length ? level[siblingIdx] : zeros[d];
    pathElements.push(sibling);
    pathIndices.push(isRight); // 1 if leaf is right child at this level

    // Hash up to the next level (only need enough to cover the tracked node's ancestors, but
    // building the full next level keeps indexing simple; trees are small in practice).
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : zeros[d];
      next.push(await poseidon2(left, right));
    }
    level = next.length > 0 ? next : [zeros[d + 1]];
    idx = idx >> 1;
  }

  // After `depth` levels the tracked node's ancestor is the root.
  const root = await computeRootFromPath(leaves[leafIndex], pathElements, pathIndices);

  return { pathElements, pathIndices, root, leafIndex };
}

/** Fold a leaf up its sibling path to the root (§2.4). */
export async function computeRootFromPath(
  leaf: bigint,
  pathElements: bigint[],
  pathIndices: number[],
): Promise<bigint> {
  if (pathElements.length !== pathIndices.length) {
    throw new Error("computeRootFromPath: pathElements/pathIndices length mismatch");
  }
  let cur = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    cur =
      pathIndices[i] === 0
        ? await poseidon2(cur, pathElements[i])
        : await poseidon2(pathElements[i], cur);
  }
  return cur;
}

/**
 * Compute the current tree root from the full ordered leaf list (for asserting against the
 * on-chain `NoteTree.currentRoot()` before proving — GF-M1 / F-5 root freshness).
 */
export async function computeStateRoot(
  leaves: bigint[],
  depth: number = TREE_DEPTH,
): Promise<bigint> {
  const zeros = await zeroLevels(depth);
  if (leaves.length === 0) return zeros[depth];
  let level = leaves.slice();
  for (let d = 0; d < depth; d++) {
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : zeros[d];
      next.push(await poseidon2(left, right));
    }
    level = next;
  }
  return level[0];
}

/** Find the leaf index of a commitment in the ordered list, or -1. */
export function findLeafIndex(leaves: bigint[], commitment: bigint): number {
  for (let i = 0; i < leaves.length; i++) {
    if (leaves[i] === commitment) return i;
  }
  return -1;
}
