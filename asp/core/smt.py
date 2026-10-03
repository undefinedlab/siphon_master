"""Revocation sparse Merkle tree — PROTOCOL §2.5 (matches spend-core/src/smt.rs)."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from core.domains import load_domains, smt_key, smt_leaf_hash
from core.poseidon import hash2

log = logging.getLogger("aspv2.smt")

SMT_DEPTH = 32


@dataclass
class SmtPath:
    path_elements: list[int]
    path_indices: list[int]


def empty_leaf() -> int:
    return 0


def build_empty_subtrees(empty: int | None = None) -> list[int]:
    """Length SMT_DEPTH+1; index SMT_DEPTH is empty revoked root."""
    leaf = empty_leaf() if empty is None else empty
    subtrees = [leaf]
    current = leaf
    for _ in range(SMT_DEPTH):
        current = hash2(current, current)
        subtrees.append(current)
    return subtrees


def path_indices_from_key(key: int) -> list[int]:
    """MSB-first from smtKey — PROTOCOL §2.5."""
    n = key
    bits: list[int] = []
    for j in range(SMT_DEPTH):
        shift = 253 - j
        bits.append((n >> shift) & 1)
    return bits


def verify_inclusion(key: int, root: int, path: SmtPath, leaf: int) -> bool:
    expected = path_indices_from_key(key)
    if path.path_indices != expected:
        return False
    current = leaf
    for i in range(SMT_DEPTH):
        sibling = path.path_elements[i]
        if path.path_indices[i] == 0:
            current = hash2(current, sibling)
        else:
            current = hash2(sibling, current)
    return current == root


def verify_non_inclusion(
    key: int,
    root: int,
    path: SmtPath,
    claimed_leaf: int,
    my_leaf_hash: int,
) -> bool:
    if claimed_leaf == my_leaf_hash:
        return False
    expected = path_indices_from_key(key)
    if path.path_indices != expected:
        return False
    current = claimed_leaf
    for i in range(SMT_DEPTH):
        sibling = path.path_elements[i]
        if path.path_indices[i] == 0:
            current = hash2(current, sibling)
        else:
            current = hash2(sibling, current)
    return current == root


def tree_path_str(bits: list[int]) -> str:
    """Root-to-leaf descent string for a key whose path_indices are MSB-first.

    The circuit fixes the convention: BindPathMsb binds pathIndices[j] = bit(253-j), and
    MerkleTreeChecker consumes pathIndices[0] FIRST, at the leaf. So the key's MSB is the
    LEAF-level branch and its 32nd bit is the top — the descent from the root is the
    MSB-first list REVERSED.

    The tree used to be descended MSB-at-top, the exact opposite. That is unobservable on an
    empty tree (both children are the same empty subtree at every level, so hash2 is symmetric
    there), which is why it survived every chain until the first revocation: inclusion proofs
    became impossible and non-inclusion only kept working because
    _path_elements_for_claimed_leaf searches for elements that happen to rebuild the root.
    """
    return "".join(str(b) for b in reversed(bits))


def _revoked_path_strings(revoked: list[int], domain_key: int) -> list[str]:
    return [
        tree_path_str(path_indices_from_key(smt_key(label, domain_key))) for label in revoked
    ]


def _has_revoked_under(prefix: str, paths: list[str]) -> bool:
    return any(p.startswith(prefix) for p in paths)


def _get_node(
    prefix: str,
    revoked: list[int],
    paths: list[str],
    domain_leaf: int,
    empty_subtrees: list[int],
    cache: dict[str, int],
) -> int:
    if prefix in cache:
        return cache[prefix]
    if not _has_revoked_under(prefix, paths):
        remaining = SMT_DEPTH - len(prefix)
        value = empty_subtrees[remaining]
        cache[prefix] = value
        return value
    if len(prefix) == SMT_DEPTH:
        for i, path in enumerate(paths):
            if path == prefix:
                lh = smt_leaf_hash(revoked[i], domain_leaf)
                cache[prefix] = lh
                return lh
        cache[prefix] = empty_leaf()
        return empty_leaf()
    left = _get_node(prefix + "0", revoked, paths, domain_leaf, empty_subtrees, cache)
    right = _get_node(prefix + "1", revoked, paths, domain_leaf, empty_subtrees, cache)
    value = hash2(left, right)
    cache[prefix] = value
    return value


def _old_sibling_prefix(level: int, bits: list[int]) -> str:
    """Prefix of the sibling met at `level` steps up from the leaf (level 0 = leaf's sibling)."""
    descent = tree_path_str(bits)
    prefix_len = SMT_DEPTH - level
    return descent[: prefix_len - 1] + str(1 - int(descent[prefix_len - 1]))


def _recompute_root_from_path(bits: list[int], path_elements: list[int], claimed_leaf: int) -> int:
    current = claimed_leaf
    for i in range(SMT_DEPTH):
        sibling = path_elements[i]
        current = hash2(current, sibling) if bits[i] == 0 else hash2(sibling, current)
    return current


def _path_elements_old_formula(
    bits: list[int],
    revoked: list[int],
    paths: list[str],
    domain_leaf: int,
    empty_subtrees: list[int],
    cache: dict[str, int],
) -> list[int]:
    return [
        _get_node(
            _old_sibling_prefix(level, bits),
            revoked,
            paths,
            domain_leaf,
            empty_subtrees,
            cache,
        )
        for level in range(SMT_DEPTH)
    ]


def _path_elements_rpp_fallback(
    bits: list[int],
    revoked_path: str,
    root: int,
    claimed_leaf: int,
    revoked: list[int],
    paths: list[str],
    domain_leaf: int,
    empty_subtrees: list[int],
    cache: dict[str, int],
) -> list[int] | None:
    for level in range(SMT_DEPTH - 1, -1, -1):
        prefix_len = SMT_DEPTH - level
        rp_prefix = revoked_path[:prefix_len]
        node = _get_node(rp_prefix, revoked, paths, domain_leaf, empty_subtrees, cache)
        if node == empty_subtrees[level]:
            continue
        path_elements = empty_subtrees[:SMT_DEPTH].copy()
        path_elements[level] = node
        if _recompute_root_from_path(bits, path_elements, claimed_leaf) == root:
            return path_elements
    return None


def _path_elements_for_claimed_leaf(
    bits: list[int],
    claimed_leaf: int,
    root: int,
    revoked: list[int],
    paths: list[str],
    domain_leaf: int,
    empty_subtrees: list[int],
    cache: dict[str, int],
) -> list[int]:
    """Siblings that reconstruct `root` from `claimed_leaf`.

    Works for inclusion and non-inclusion alike — the only difference is whether claimed_leaf is
    the label's own leaf hash or the (possibly empty) node sitting at its slot. Every candidate is
    checked against `root` before being returned, which is what keeps this correct despite the
    tree being built MSB-at-top while the circuit reconstructs leaf-first.
    """
    old = _path_elements_old_formula(bits, revoked, paths, domain_leaf, empty_subtrees, cache)
    if _recompute_root_from_path(bits, old, claimed_leaf) == root:
        return old
    for revoked_path in paths:
        fallback = _path_elements_rpp_fallback(
            bits,
            revoked_path,
            root,
            claimed_leaf,
            revoked,
            paths,
            domain_leaf,
            empty_subtrees,
            cache,
        )
        if fallback and _recompute_root_from_path(bits, fallback, claimed_leaf) == root:
            return fallback
    return old


def revoked_tree_root(
    revoked: list[int],
    domain_key: int | None = None,
    domain_leaf: int | None = None,
    empty_subtrees: list[int] | None = None,
) -> int:
    domains = load_domains()
    dk = domain_key if domain_key is not None else domains["DOMAIN_SMT_KEY"]
    dl = domain_leaf if domain_leaf is not None else domains["DOMAIN_SMT_LEAF"]
    empty = empty_subtrees or build_empty_subtrees()
    if not revoked:
        return empty[SMT_DEPTH]
    paths = _revoked_path_strings(revoked, dk)
    return _get_node("", revoked, paths, dl, empty, {})


def root_after_insert(
    label: int,
    domain_key: int | None = None,
    domain_leaf: int | None = None,
    empty_subtrees: list[int] | None = None,
) -> int:
    domains = load_domains()
    dk = domain_key if domain_key is not None else domains["DOMAIN_SMT_KEY"]
    dl = domain_leaf if domain_leaf is not None else domains["DOMAIN_SMT_LEAF"]
    empty = empty_subtrees or build_empty_subtrees()
    key = smt_key(label, dk)
    leaf = smt_leaf_hash(label, dl)
    indices = path_indices_from_key(key)
    current = leaf
    for level, bit in enumerate(indices):
        empty_sibling = empty[level]
        current = hash2(current, empty_sibling) if bit == 0 else hash2(empty_sibling, current)
    return current


def empty_tree_path_for_key(key: int, empty_subtrees: list[int]) -> SmtPath:
    return SmtPath(empty_subtrees[:SMT_DEPTH].copy(), path_indices_from_key(key))


def non_inclusion_path(
    target_label: int,
    revoked: list[int],
    domain_key: int | None = None,
    domain_leaf: int | None = None,
    empty_subtrees: list[int] | None = None,
) -> tuple[int, SmtPath, int]:
    domains = load_domains()
    dk = domain_key if domain_key is not None else domains["DOMAIN_SMT_KEY"]
    dl = domain_leaf if domain_leaf is not None else domains["DOMAIN_SMT_LEAF"]
    empty = empty_subtrees or build_empty_subtrees()
    if not revoked:
        key = smt_key(target_label, dk)
        root = empty[SMT_DEPTH]
        path = empty_tree_path_for_key(key, empty)
        return root, path, empty_leaf()
    paths = _revoked_path_strings(revoked, dk)
    cache: dict[str, int] = {}
    root = _get_node("", revoked, paths, dl, empty, cache)
    key = smt_key(target_label, dk)
    bits = path_indices_from_key(key)
    claimed_leaf = _get_node(tree_path_str(bits), revoked, paths, dl, empty, cache)
    path_elements = _path_elements_for_claimed_leaf(
        bits, claimed_leaf, root, revoked, paths, dl, empty, cache
    )
    return root, SmtPath(path_elements, bits), claimed_leaf


def inclusion_path(
    label: int,
    revoked: list[int],
    domain_key: int | None = None,
    domain_leaf: int | None = None,
    empty_subtrees: list[int] | None = None,
) -> tuple[int, SmtPath] | None:
    """Revoked-tree inclusion witness for `label`, against the REAL tree of all revoked labels.

    This used to call root_after_insert(), which builds a tree containing only `label` and empty
    siblings everywhere else. That root ignores every other revocation and does not match the
    root the postman publishes on-chain, so any ragequit built from it failed spend-core with
    RagequitBadStatus and could never have been submitted. It was invisible while the revoked
    tree was empty, which it was on every chain until the first revocation.

    Returns None rather than a path that cannot verify — a bad exit witness is worse than none.
    """
    domains = load_domains()
    dk = domain_key if domain_key is not None else domains["DOMAIN_SMT_KEY"]
    dl = domain_leaf if domain_leaf is not None else domains["DOMAIN_SMT_LEAF"]
    empty = empty_subtrees or build_empty_subtrees()
    if label not in revoked:
        return None

    paths = _revoked_path_strings(revoked, dk)
    cache: dict[str, int] = {}
    root = _get_node("", revoked, paths, dl, empty, cache)
    bits = path_indices_from_key(smt_key(label, dk))
    leaf = smt_leaf_hash(label, dl)
    path_elements = _path_elements_for_claimed_leaf(
        bits, leaf, root, revoked, paths, dl, empty, cache
    )
    if _recompute_root_from_path(bits, path_elements, leaf) != root:
        log.error("inclusion path for label %s does not reconstruct root", label)
        return None
    return root, SmtPath(path_elements, bits)
