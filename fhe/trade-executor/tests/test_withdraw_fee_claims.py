"""The claims scan must call web3 with the argument names web3 actually accepts.

`get_logs(from_block=..., to_block=...)` raises TypeError on web3.py 6.x — the kwargs are
fromBlock/toBlock. It failed on every call, so /admin/fees reported claimed=null for every vault
and understated what had already been paid out. A signature typo is invisible until something
asserts on it.
"""
import inspect

import pytest

from withdraw_fee_ledger import _claimed_total


class _Entry(dict):
    pass


class _Event:
    """Stands in for a contract event, accepting ONLY the real web3 6.x kwargs."""

    def __init__(self, log, seen):
        self._log = log
        self._seen = seen

    def __call__(self):
        return self

    def get_logs(self, argument_filters=None, fromBlock=None, toBlock=None, block_hash=None):
        self._seen.append((fromBlock, toBlock))
        return [e for e in self._log if fromBlock <= e["block"] <= toBlock]


class _Vault:
    def __init__(self, margin, gas, seen):
        self.events = self
        self.MarginClaimed = _Event(margin, seen)
        self.GasReimburseClaimed = _Event(gas, seen)


def _entry(block, amount):
    return {"block": block, "args": {"amount": amount}}


def test_claims_are_summed_across_both_events():
    seen = []
    vault = _Vault([_entry(5, 100), _entry(9, 50)], [_entry(7, 3)], seen)
    assert _claimed_total(vault, 0, 20) == 153


def test_it_calls_web3_with_fromBlock_toBlock_not_snake_case():
    # The regression: snake_case kwargs raise TypeError, which /admin/fees swallowed into
    # claimed_error and reported claimed=null.
    sig = inspect.signature(_Event([], []).get_logs).parameters
    assert "fromBlock" in sig and "toBlock" in sig
    seen = []
    _claimed_total(_Vault([], [], seen), 0, 5)
    assert seen, "get_logs was never called"


def test_the_scan_is_chunked_and_covers_the_whole_range_exactly_once():
    seen = []
    _claimed_total(_Vault([], [], seen), 0, 25_000)
    margin = seen[: len(seen) // 2]
    assert margin[0][0] == 0
    assert margin[-1][1] == 25_000
    # contiguous, no gaps and no overlap — a gap would silently drop claims
    for (_, prev_end), (next_start, _) in zip(margin, margin[1:]):
        assert next_start == prev_end + 1


def test_an_empty_range_still_terminates():
    seen = []
    assert _claimed_total(_Vault([], [], seen), 10, 9) == 0
    assert seen == []


def test_a_node_error_propagates_rather_than_reporting_zero_claims():
    # Reporting 0 claimed when the node refused the scan would overstate what is still owed.
    class Boom(_Event):
        def get_logs(self, **kw):
            raise RuntimeError("node refused range")

    vault = _Vault([], [], [])
    vault.MarginClaimed = Boom([], [])
    with pytest.raises(RuntimeError):
        _claimed_total(vault, 0, 10)
