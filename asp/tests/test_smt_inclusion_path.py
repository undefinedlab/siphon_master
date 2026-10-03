"""The revoked-SMT inclusion path must agree with the root the postman publishes.

inclusion_path() used to build a tree containing only the target label, so its root ignored
every other revocation and never matched revoked_tree_root() — the value that actually goes
on-chain. Any ragequit built from it was rejected by spend-core (RagequitBadStatus) and could
never have been submitted.

Nothing caught it because the revoked tree was empty on every chain until the first revocation,
and on an empty tree both children are identical at every level, so the two constructions agree
by coincidence. These tests therefore care mostly about the >= 2 revoked-labels case.
"""
from __future__ import annotations

import pytest

from core.smt import (
    SmtPath,
    inclusion_path,
    revoked_tree_root,
    verify_inclusion,
)
from core.domains import smt_key, smt_leaf_hash

LABELS = [
    7143263904541149067907838128356510077610966361485705099550137616217988879471,
    2736023812826611038065282075360688208437534411779773435507364399063724936366,
    12345678901234567890,
    999,
]


@pytest.mark.parametrize("count", [1, 2, 3, 4])
def test_inclusion_root_matches_published_root(count):
    """The witness root must equal the root the postman publishes, for every set size."""
    revoked = LABELS[:count]
    published = revoked_tree_root(revoked)
    for label in revoked:
        built = inclusion_path(label, revoked)
        assert built is not None, f"no inclusion path for {label} in a set of {count}"
        root, path = built
        assert root == published, (
            f"inclusion root disagrees with published root for set size {count}"
        )
        assert verify_inclusion(smt_key(label), published, path, smt_leaf_hash(label))


def test_multi_label_tree_is_not_a_single_label_tree():
    """Guard the exact regression: a 2-label tree must not equal either 1-label tree."""
    a, b = LABELS[0], LABELS[1]
    both = revoked_tree_root([a, b])
    assert both != revoked_tree_root([a])
    assert both != revoked_tree_root([b])
    # and the inclusion witness for `a` must be against the 2-label root, not the 1-label one
    root, _ = inclusion_path(a, [a, b])
    assert root == both


def test_unrevoked_label_has_no_inclusion_path():
    built = inclusion_path(LABELS[3], [LABELS[0], LABELS[1]])
    assert built is None
