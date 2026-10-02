"""Which venue a proof routes to is a money decision.

A v3 proof handed to the v4 hook cannot satisfy beforeSwap; a v4 proof sent down the v3 path
spends a nullifier on a withdraw the pool never agreed to. The dispatch reads `venue` off the
proof (not the chain), so pin that parsing — including the wrapper unwrap and the malformed case.
"""
import json

import pytest

from executor_runner import _is_v4_proof


@pytest.mark.parametrize(
    "zkp_data,expected",
    [
        ({"venue": "v4"}, True),
        ({"proof": {"venue": "v4"}}, True),                  # browser wraps the proof
        (json.dumps({"venue": "v4"}), True),                 # DB round-trips it as text
        (json.dumps({"proof": {"venue": "v4"}}), True),
        ({"venue": "v3"}, False),
        ({}, False),
        (None, False),
        ("", False),
        ("not json{", False),                                 # malformed -> v3, fails loudly there
        ([1, 2], False),
        ({"venue": "V4"}, False),                             # exact match only
    ],
)
def test_venue_dispatch(zkp_data, expected):
    assert _is_v4_proof(zkp_data) is expected
