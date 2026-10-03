#!/usr/bin/env python3
"""Trace one real Deposited log through every consumer that decodes it.

The D1 drift was invisible because each repo carries its own hand-written ABI and nothing
compared them. This fetches an actual log and decodes it with each consumer's ABI, so a
disagreement shows up as a diff rather than as a watcher that silently admits nothing.

Consumers: siphon-contracts-v2 (source of truth), siphon-asp-v2, siphon-indexer-v2.

Run: python scripts/trace_deposited.py --tx 0x... [--chain-id 11155111]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from web3 import Web3

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SIPHON = ROOT.parent

CONTRACT_SOL = SIPHON / "siphon-contracts-v2" / "evm" / "src" / "VaultKernel.sol"
INDEXER_ABI_TS = SIPHON / "siphon-indexer-v2" / "abis" / "VaultKernel.ts"


def _sig(inputs: list[tuple[bool, str]]) -> str:
    return f"Deposited({','.join(t for _, t in inputs)})"


def from_contract_source() -> list[tuple[bool, str]]:
    m = re.search(r"\bevent\s+Deposited\s*\((.*?)\)\s*;", CONTRACT_SOL.read_text(), re.DOTALL)
    if not m:
        raise SystemExit(f"no `event Deposited` in {CONTRACT_SOL}")
    return [("indexed" in p.split(), p.split()[0]) for p in m.group(1).split(",")]


def from_aspv2() -> list[tuple[bool, str]]:
    from chain_verify import DEPOSITED_ABI

    return [(i["indexed"], i["type"]) for i in DEPOSITED_ABI[0]["inputs"]]


def from_indexer() -> list[tuple[bool, str]]:
    """Pull the Deposited inputs out of the Ponder ABI (a .ts literal, not JSON)."""
    src = INDEXER_ABI_TS.read_text()
    m = re.search(r'name:\s*"Deposited".*?inputs:\s*\[(.*?)\]', src, re.DOTALL)
    if not m:
        raise SystemExit(f"no Deposited entry in {INDEXER_ABI_TS}")
    out = []
    for line in m.group(1).splitlines():
        t = re.search(r'type:\s*"(\w+)"', line)
        if t:
            out.append((bool(re.search(r"indexed:\s*true", line)), t.group(1)))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tx", required=True)
    ap.add_argument("--chain-id", type=int, default=11155111)
    args = ap.parse_args()

    consumers = {
        "siphon-contracts-v2 (truth)": from_contract_source(),
        "siphon-asp-v2": from_aspv2(),
        "siphon-indexer-v2": from_indexer(),
    }

    print("== ABI agreement ==")
    truth = consumers["siphon-contracts-v2 (truth)"]
    truth_topic = Web3.keccak(text=_sig(truth)).hex()
    if not truth_topic.startswith("0x"):
        truth_topic = "0x" + truth_topic
    ok = True
    for name, inputs in consumers.items():
        same = inputs == truth
        ok &= same
        idx = "".join("I" if i else "." for i, _ in inputs)
        print(f"  {'OK ' if same else 'BAD'} {name:32} {_sig(inputs)}  indexed[{idx}]")
    print(f"  topic0 {truth_topic}")
    if not ok:
        print("\nABIs disagree — the watcher/indexer cannot see deposits.")
        return 1

    # Now prove it against a real log: topic0 must match and the fields must decode sanely.
    rpc = os.environ.get("ASP_RPC_URL")
    if not rpc:
        print("\n(no ASP_RPC_URL — skipping live log decode)")
        return 0
    w3 = Web3(Web3.HTTPProvider(rpc))
    receipt = w3.eth.get_transaction_receipt(args.tx)
    logs = [l for l in receipt["logs"] if l["topics"] and l["topics"][0].hex().lstrip("0x") == truth_topic.lstrip("0x")]
    print(f"\n== live log ({args.tx[:18]}… block {receipt['blockNumber']}) ==")
    if not logs:
        seen = {l["topics"][0].hex() for l in receipt["logs"] if l["topics"]}
        print(f"  no Deposited log matched topic0. topics present: {seen}")
        return 1

    abi = [{"anonymous": False, "name": "Deposited", "type": "event",
            "inputs": [{"indexed": i, "type": t, "name": n} for (i, t), n in zip(
                truth, ["depositor", "token", "amount", "commitment", "depositNonce", "stateRootAfter"])]}]
    ev = w3.eth.contract(abi=abi).events.Deposited().process_log(logs[0])
    a = dict(ev["args"])
    print(f"  vault         {logs[0]['address']}")
    for k, v in a.items():
        print(f"  {k:13} {v}")

    # The trap I hit by hand: with `token` indexed, data word[0] is the DEPOSITOR, not the
    # token. Anything building a witness off raw data must use uint160(token) for assetId.
    word0 = "0x" + logs[0]["data"].hex().removeprefix("0x")[24:64]
    print(f"\n  data word[0]  {word0}  <- depositor, NOT token (token is topic[1])")
    print(f"  inAssetId     {int(a['token'], 16)}  = uint160(token)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
