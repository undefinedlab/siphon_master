"""The deposit watcher must catch up in bounded eth_getLogs ranges, not ask for the whole backlog."""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import config
from db import get_meta, session, set_meta, watcher_cursor_key

_spec = importlib.util.spec_from_file_location(
    "watch_deposits", Path(__file__).resolve().parents[1] / "scripts" / "watch_deposits.py"
)
W = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(W)


def test_backlog_is_scanned_in_capped_chunks(monkeypatch):
    calls = []
    eth = SimpleNamespace(block_number=100_000, get_logs=lambda f: calls.append(f) or [])
    w3 = SimpleNamespace(eth=eth)
    w3.eth.contract = lambda abi: SimpleNamespace(events=SimpleNamespace(Deposited=lambda: None))
    monkeypatch.setattr(W, "_w3", lambda chain_id: w3)
    monkeypatch.setattr(W, "_vault", lambda chain_id: "0x" + "11" * 20)
    monkeypatch.setattr(config, "CHAIN_MIN_CONFIRMATIONS", 0)
    monkeypatch.setattr(config, "WATCHER_MAX_RANGE", 2000)

    W.init_db()
    with session() as db:
        set_meta(db, watcher_cursor_key(8453), "70000")  # 30k blocks behind
        db.commit()

    out = W.poll_once(8453)
    assert (calls[-1]["fromBlock"], calls[-1]["toBlock"]) == (70001, 72000)
    assert (out["fromBlock"], out["toBlock"]) == (70001, 72000)
    with session() as db:
        assert get_meta(db, watcher_cursor_key(8453)) == "72000"  # next poll continues from here

    W.poll_once(8453)
    assert (calls[-1]["fromBlock"], calls[-1]["toBlock"]) == (72001, 74000)
