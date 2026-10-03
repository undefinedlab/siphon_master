"""Pin our Deposited ABI to the contract source.

This drift is silent and total: a wrong ABI gives a wrong topic0, eth_getLogs matches
nothing, and the watcher reports a healthy `scanned: N, admitted: 0, errors: 0` forever.
Nothing else in the stack notices. D1 added `token` and moved `indexed` onto it while
this repo still described the pre-D1 5-argument event.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

CONTRACT = (
    Path(__file__).resolve().parents[2]
    / "siphon-contracts-v2"
    / "evm"
    / "src"
    / "VaultKernel.sol"
)


def _event_from_source(path: Path, name: str) -> list[tuple[bool, str]]:
    """[(indexed, type), ...] for `event <name>(...)` in a .sol file."""
    src = path.read_text()
    m = re.search(rf"\bevent\s+{name}\s*\((.*?)\)\s*;", src, re.DOTALL)
    assert m, f"no `event {name}` in {path}"
    args = []
    for raw in m.group(1).split(","):
        parts = raw.split()
        assert parts, f"empty arg in event {name}"
        args.append(("indexed" in parts, parts[0]))
    return args


@pytest.mark.skipif(not CONTRACT.exists(), reason="siphon-contracts-v2 not checked out")
def test_deposited_abi_matches_contract():
    from chain_verify import DEPOSITED_ABI, DEPOSITED_SIGNATURE

    on_chain = _event_from_source(CONTRACT, "Deposited")
    ours = [(i["indexed"], i["type"]) for i in DEPOSITED_ABI[0]["inputs"]]

    # Types decide topic0, so a mismatch here means the watcher can never see a deposit.
    assert [t for _, t in ours] == [t for _, t in on_chain]
    assert DEPOSITED_SIGNATURE == f"Deposited({','.join(t for _, t in on_chain)})"

    # `indexed` decides whether a field lands in topics or data. Getting this wrong still
    # matches topic0 but decodes every field into the wrong slot.
    assert [x for x, _ in ours] == [x for x, _ in on_chain]


def test_topic_is_derived_not_literal():
    """The original bug was a hand-written topic0 that disagreed with the ABI."""
    from web3 import Web3

    import chain_verify

    assert chain_verify.DEPOSITED_TOPIC == "0x" + Web3.keccak(
        text=chain_verify.DEPOSITED_SIGNATURE
    ).hex().removeprefix("0x")

    watcher = (Path(__file__).resolve().parents[1] / "scripts" / "watch_deposits.py").read_text()
    assert not re.search(r'"0x[0-9a-fA-F]{64}"', watcher), "topic0 literal is back in the watcher"
