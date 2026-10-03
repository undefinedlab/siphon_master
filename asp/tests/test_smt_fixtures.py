"""SMT parity — zkv2 test-vectors/smt/*."""
from __future__ import annotations

from core.domains import load_domains, smt_key, smt_leaf_hash
from core.smt import (
    build_empty_subtrees,
    empty_leaf,
    non_inclusion_path,
    revoked_tree_root,
    verify_non_inclusion,
)


def test_empty_revoked_root(poseidon_ready):
    from tests.conftest import load_json

    data = load_json("smt/empty-subtrees.json")
    empty = build_empty_subtrees(empty_leaf())
    assert str(empty[32]) == data["EMPTY_REVOKED_ROOT"]
    domains = load_domains()
    root = revoked_tree_root([], domains["DOMAIN_SMT_KEY"], domains["DOMAIN_SMT_LEAF"], empty)
    assert str(root) == data["EMPTY_REVOKED_ROOT"]


def test_revoked_non_inclusion_fixture(poseidon_ready):
    from tests.conftest import load_json

    data = load_json("smt/revoked-non-inclusion.json")
    domains = load_domains()
    dk, dl = domains["DOMAIN_SMT_KEY"], domains["DOMAIN_SMT_LEAF"]
    empty = build_empty_subtrees()
    revoked = int(data["revokedLabel"])
    target = int(data["targetLabel"])
    root = revoked_tree_root([revoked], dk, dl, empty)
    assert str(root) == data["revokedRoot"]
    got_root, path, claimed = non_inclusion_path(target, [revoked], dk, dl, empty)
    assert str(got_root) == data["revokedRoot"]
    assert [str(x) for x in path.path_elements] == data["pathElements"]
    assert path.path_indices == data["pathIndices"]
    key = smt_key(target, dk)
    mine = smt_leaf_hash(target, dl)
    assert verify_non_inclusion(key, root, path, claimed, mine)
