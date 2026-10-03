"""ASP association Merkle tree — PROTOCOL §2.6 (matches spend-core/src/asp.rs)."""
from __future__ import annotations

from dataclasses import dataclass

from core.poseidon import SNARK_SCALAR_FIELD, hash2

TREE_DEPTH = 32


@dataclass
class MerklePath:
    path_elements: list[int]
    path_indices: list[int]


def path_indices_from_leaf_index(index: int) -> list[int]:
    """LSB-first at level 0 — same as NoteTree.sol / MerkleTree.sol."""
    return [(index >> i) & 1 for i in range(TREE_DEPTH)]


def path_index_bind_ok(index: int, path_indices: list[int]) -> bool:
    if len(path_indices) != TREE_DEPTH:
        return False
    expected = path_indices_from_leaf_index(index)
    return path_indices == expected


def verify_inclusion(
    label: int,
    root: int,
    path: MerklePath,
    leaf_index: int | None = None,
) -> bool:
    if leaf_index is not None and not path_index_bind_ok(leaf_index, path.path_indices):
        return False
    current = label
    for i in range(TREE_DEPTH):
        sibling = path.path_elements[i]
        if path.path_indices[i] == 0:
            current = hash2(current, sibling)
        else:
            current = hash2(sibling, current)
    return current == root


class AspTree:
    """Incremental ASP tree — identical insert to NoteTree.sol / spend-core AspTree."""

    def __init__(self) -> None:
        self.zeros: list[int] = [0] * TREE_DEPTH
        z = 0
        for i in range(TREE_DEPTH):
            self.zeros[i] = z
            z = hash2(z, z)
        self.empty_root = z
        self.filled_subtrees = self.zeros.copy()
        self.current_root = self.empty_root
        self.leaf_count = 0
        self.labels: list[int] = []

    def root(self) -> int:
        return self.current_root

    def path_for_next_insert(self) -> MerklePath:
        return self._path_at_index(self.leaf_count)

    def _path_at_index(self, index: int) -> MerklePath:
        path_elements: list[int] = []
        current_index = index
        for i in range(TREE_DEPTH):
            sibling = self.zeros[i] if current_index % 2 == 0 else self.filled_subtrees[i]
            path_elements.append(sibling)
            current_index >>= 1
        return MerklePath(path_elements, path_indices_from_leaf_index(index))

    def insert(self, label: int) -> tuple[int, MerklePath]:
        if label == 0 or label in self.labels:
            raise ValueError("duplicate or zero label")
        index = self.leaf_count
        path = self.path_for_next_insert()
        current_index = index
        current_level_hash = label
        for i in range(TREE_DEPTH):
            if current_index % 2 == 0:
                self.filled_subtrees[i] = current_level_hash
                current_level_hash = hash2(current_level_hash, self.zeros[i])
            else:
                current_level_hash = hash2(self.filled_subtrees[i], current_level_hash)
            current_index >>= 1
        self.current_root = current_level_hash
        self.leaf_count += 1
        self.labels.append(label)
        return self.current_root, path

    def path_for_label(self, label: int) -> tuple[int, MerklePath]:
        """Rebuild path for an existing label, against the COMPLETE current tree.

        The previous implementation replayed inserts and returned as soon as it reached the target
        leaf, so it handed back the path and root as they were AT INSERTION TIME. Every leaf except
        the most recently admitted one therefore got a stale path: adding a later leaf changes an
        earlier leaf's sibling, so the witness reproduced a historical root and the spend failed
        the circuit's `AspInclusion` root assert (asp.circom:28) — funds admitted and unspendable.
        """
        if label not in self.labels:
            raise KeyError(label)
        return self.path_for_index(self.labels.index(label))

    def path_for_index(self, index: int) -> tuple[int, MerklePath]:
        """Sibling path for `index` over all current leaves, level by level to the root."""
        if index < 0 or index >= len(self.labels):
            raise IndexError(index)

        level: list[int] = list(self.labels)
        path_elements: list[int] = []
        cursor = index

        for depth in range(TREE_DEPTH):
            sibling_index = cursor ^ 1
            sibling = level[sibling_index] if sibling_index < len(level) else self.zeros[depth]
            path_elements.append(sibling)

            # Collapse this level, padding any missing right child with the level's zero value —
            # the same convention `insert` uses via `self.zeros`.
            nxt: list[int] = []
            for i in range(0, len(level), 2):
                left = level[i]
                right = level[i + 1] if i + 1 < len(level) else self.zeros[depth]
                nxt.append(hash2(left, right))
            level = nxt or [self.zeros[depth + 1] if depth + 1 < TREE_DEPTH else self.empty_root]
            cursor >>= 1

        return level[0], MerklePath(path_elements, path_indices_from_leaf_index(index))
