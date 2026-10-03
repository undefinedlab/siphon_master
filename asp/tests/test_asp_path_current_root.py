"""Every admitted leaf must prove against the CURRENT admitted root, not a historical one.

`AspTree.path_for_label` replayed inserts and returned the moment it reached the target leaf, so it
handed back the path and root as they stood AT INSERTION TIME. Adding any later leaf changes an
earlier leaf's sibling, so all but the most recently admitted label served a stale witness. On-chain
that surfaced as the circuit's `AspInclusion` root assert (circuits/lib/asp.circom:28) failing:

    Assert Failed. Error in template AspInclusion_151 line: 28

which reads as a proving bug, not an ASP one. The funds were admitted and simply unspendable.

Nothing caught it because the newest leaf ALWAYS verifies — its insertion-time root is the current
root — so any test that admitted one label, or only checked the last one, passed.
"""
from __future__ import annotations

import pytest

from core.asp_tree import AspTree, verify_inclusion


def _tree(n: int) -> tuple[AspTree, list[int]]:
    tree = AspTree()
    labels = [1000 + i for i in range(n)]
    for label in labels:
        tree.insert(label)
    return tree, labels


@pytest.mark.parametrize("n", [1, 2, 3, 4, 5, 8, 9, 16, 17])
def test_every_leaf_proves_against_the_final_root(poseidon_ready, n):
    """The property that matters: not just the newest leaf."""
    tree, labels = _tree(n)
    root = tree.root()
    for index, label in enumerate(labels):
        path_root, path = tree.path_for_label(label)
        assert path_root == root, f"leaf {index}/{n} served a non-current root"
        assert verify_inclusion(label, root, path, index), f"leaf {index}/{n} failed inclusion"


def test_earlier_leaf_path_changes_when_a_later_leaf_is_added(poseidon_ready):
    """Guard the exact regression: the stale witness must not still verify."""
    one = AspTree()
    one.insert(7001)
    _, stale = one.path_for_label(7001)

    two = AspTree()
    two.insert(7001)
    two.insert(7002)
    fresh_root, fresh = two.path_for_label(7001)

    assert fresh_root == two.root()
    assert stale.path_elements != fresh.path_elements, "sibling must change when leaf 1 lands"
    assert verify_inclusion(7001, two.root(), fresh, 0), "current witness must verify"
    assert not verify_inclusion(7001, two.root(), stale, 0), (
        "the insertion-time witness must NOT verify against the current root — "
        "if it does, this test cannot detect the regression it exists for"
    )


def test_path_for_index_rejects_out_of_range(poseidon_ready):
    tree, _ = _tree(3)
    with pytest.raises(IndexError):
        tree.path_for_index(3)
