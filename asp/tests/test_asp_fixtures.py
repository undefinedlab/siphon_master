"""ASP tree parity — zkv2 test-vectors/asp/*."""
from __future__ import annotations

from core.asp_tree import AspTree, MerklePath, verify_inclusion


def test_empty_root_matches_fixture(poseidon_ready):
    from tests.conftest import load_json

    data = load_json("asp/empty-root.json")
    tree = AspTree()
    assert str(tree.root()) == data["emptyRoot"]


def test_inclusion_path_fixture(poseidon_ready):
    from tests.conftest import load_json

    data = load_json("asp/inclusion-path.json")
    tree = AspTree()
    for i, entry in enumerate(data["labels"]):
        label = int(entry["label"])
        root, path = tree.insert(label)
        assert str(root) == entry["root"]
        assert tree.leaf_count - 1 == entry["leafIndex"]
        assert [str(x) for x in path.path_elements] == entry["pathElements"]
        assert path.path_indices == entry["pathIndices"]
        mp = MerklePath(path.path_elements, path.path_indices)
        assert verify_inclusion(label, root, mp, entry["leafIndex"])
