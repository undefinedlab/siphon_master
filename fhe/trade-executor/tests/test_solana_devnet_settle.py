"""Devnet settlement: a fired order's output returns to the user's vault, and a settlement that
moved funds part way is always finished, never dropped or re-run from scratch. No RPC: the
Meteora script is replaced by canned stdout."""
from __future__ import annotations

import json
import subprocess

import pytest

from test_bridge_payout import A, ctx  # noqa: F401  (fixtures)

import solana_devnet_strategy as s

SETTLE = "8xueCcQRMhKo5CtppfmxXar2LuVaHfiiN3VzhxepqNEg"


def _pkg(**over):
    p = {
        "venue": "meteora-dlmm", "proof_hex": "ab" * 256, "binder_hex": "cd" * 32,
        "publics": ["0"] * 25, "nullifiers_hex": ["11" * 32],
        "mint": "So11111111111111111111111111111111111111112", "settlement": SETTLE,
        "meteora_pool": "BY4cLgYMpE1AA5X5jiXHEMTrVkG7uhDvr6KxjU8YfCEZ", "circuit_index": 0,
        "return_precommitment": "123", "return_user_salt": "456",
    }
    p.update(over)
    return p


def test_package_must_withdraw_to_this_settlement_wallet_and_carry_the_return_note():
    assert s.validate_meteora_zk_package(_pkg(), settlement=SETTLE, vault_output=True) is None
    assert "another wallet" in s.validate_meteora_zk_package(_pkg(settlement="x" * 44), settlement=SETTLE)
    assert "WITHDRAW" in s.validate_meteora_zk_package(_pkg(publics=["2"] + ["0"] * 24))
    assert "return_precommitment" in s.validate_meteora_zk_package(
        _pkg(return_user_salt="0"), vault_output=True)


@pytest.fixture
def node(monkeypatch, tmp_path):
    """Replace `node execute-zk-meteora.mjs` with canned (stdout, exit) results, recording input."""
    script = tmp_path / "execute-zk-meteora.mjs"
    script.write_text("")
    (tmp_path / "relay-zk-withdraw.mjs").write_text("")
    monkeypatch.setattr(s, "_meteora_script", lambda: script)
    calls = {"inputs": [], "results": []}

    def run(cmd, input=None, **_):
        calls["inputs"].append(json.loads(input))
        out, code = calls["results"].pop(0)
        if code == "timeout":
            raise subprocess.TimeoutExpired(cmd, 1, output=out)
        return subprocess.CompletedProcess(cmd, code, stdout=out, stderr="")

    monkeypatch.setattr(s.subprocess, "run", run)
    return calls


def _lines(*objs):
    return "\n".join(json.dumps(o) for o in objs) + "\n"


STRAT = {"output_mode": "vault", "max_slippage_bps": 80}
SPENT = {"stage": "SPENT", "resume": {"stage": "SPENT", "spend_sig": "S1", "amount_in": "5"}}
SWAPPED = {"stage": "SWAPPED", "resume": {"stage": "SWAPPED", "spend_sig": "S1", "swap_sig": "W1",
                                          "amount_in": "5", "amount_out": "9"}}
NOTE = {"commitment": "77", "deposit_nonce": "3", "leaf_index": "12", "amount": "9", "user_salt": "456"}
DONE = {"ok": True, "status": "EXECUTED", "spend_sig": "S1", "returned_note": NOTE}


def test_vault_output_is_sent_as_a_return_not_a_recipient(node):
    node["results"].append((_lines(SPENT, SWAPPED, DONE), 0))
    out = s.settle(STRAT, _pkg())
    assert out["status"] == "EXECUTED" and out["settlement"]["returned_note"] == NOTE
    sent = node["inputs"][0]
    assert sent["return"] == {"precommitment": "123", "user_salt": "456"}
    assert "recipient" not in sent and sent["slippage_bps"] == 80


@pytest.mark.parametrize("stdout,code", [
    (_lines(SPENT, SWAPPED, {"ok": False, "code": "STAGED", "resume": SWAPPED["resume"]}), 5),
    (_lines(SPENT, SWAPPED), 1),            # crashed after the swap: the stage still stands
    (_lines(SPENT, SWAPPED), "timeout"),    # killed mid-deposit
])
def test_anything_after_the_spend_is_staged_with_the_latest_resume_state(node, stdout, code):
    node["results"].append((stdout, code))
    out = s.settle(STRAT, _pkg())
    assert out["status"] == "STAGED" and out["settlement"]["stage"] == "SWAPPED"


def test_nothing_sent_outcomes(node):
    node["results"] += [(_lines({"ok": False, "code": "NEEDS_REPROOF"}), 3),
                        (_lines({"ok": False, "code": "NO_ROUTE"}), 4),
                        (_lines({"ok": False, "code": "SPENT_UNTRACKED", "error": "x"}), 1)]
    assert [s.settle(STRAT, _pkg())["status"] for _ in range(3)] == ["NEEDS_REPROOF", "NO_ROUTE", "FAILED"]


def _row(ctx, **over):
    from database import Strategy

    fields = dict(user_id=SETTLE, strategy_type="LIMIT_SELL", asset_in="SOL", asset_out="USDC",
                  amount=0.1, recipient_address=SETTLE, from_chain="900002", to_chain="900002",
                  output_mode="vault", status="EXECUTING", zkp_data=json.dumps(_pkg()))
    fields.update(over)
    row = Strategy(**fields)
    ctx.db.session.add(row)
    ctx.db.session.commit()
    return row.id


def test_a_staged_settlement_is_finished_by_the_scheduler_from_where_it_stopped(ctx, node):
    from database import Strategy

    sid = _row(ctx)
    node["results"].append((_lines(SPENT, SWAPPED), 1))
    assert s.settle_strategy_row(sid)["status"] == "STAGED"
    assert Strategy.query.get(sid).status == "SETTLING"

    node["results"].append((_lines(DONE), 0))
    s.process_staged()
    row = Strategy.query.get(sid)
    assert node["inputs"][1]["resume"]["stage"] == "SWAPPED", "resumed, not re-spent"
    assert row.status == "EXECUTED" and row.tx_hash == "S1"
    assert json.loads(row.settlement)["returned_note"] == NOTE


def test_a_stale_proof_waits_for_the_browser_instead_of_rerunning_every_tick(ctx, node):
    from database import Strategy

    sid = _row(ctx)
    node["results"].append((_lines({"ok": False, "code": "NEEDS_REPROOF"}), 3))
    assert s.settle_strategy_row(sid)["status"] == "NEEDS_REPROOF"
    assert Strategy.query.get(sid).status == "PENDING"
    assert s.settle_strategy_row(sid)["status"] == "NEEDS_REPROOF"
    assert len(node["inputs"]) == 1, "the same stale proof is not run again"


def test_a_stale_leg_waits_and_a_fresh_proof_reaches_only_that_leg(ctx, node):
    from database import StrategyLeg

    sid = _row(ctx, strategy_type="TWAP", leg_count=2, status="ARMED", zkp_data=None)
    for i in range(2):
        ctx.db.session.add(StrategyLeg(strategy_id=sid, leg_index=i, amount=0.05, eval_mode="time",
                                       zkp_data=json.dumps(_pkg()), status="EXECUTING"))
    ctx.db.session.commit()
    leg0 = StrategyLeg.query.filter_by(strategy_id=sid, leg_index=0).first()
    node["results"].append((_lines({"ok": False, "code": "NEEDS_REPROOF"}), 3))
    assert s.settle_leg_row(leg0.id, {"output_mode": "vault"})["status"] == "NEEDS_REPROOF"
    assert s.settle_leg_row(leg0.id, {"output_mode": "vault"})["status"] == "NEEDS_REPROOF"
    assert len(node["inputs"]) == 1, "the same stale leg proof is not run again"

    from app import app
    from unittest import mock
    with mock.patch("app._wallet_authorizes", return_value=True), \
         mock.patch("solana_devnet_strategy.settlement_pubkey", return_value=SETTLE):
        fn = app.view_functions["execute_strategy_endpoint"]
        while hasattr(fn, "__wrapped__"):
            fn = fn.__wrapped__
        fresh = _pkg(binder_hex="ee" * 32)
        with app.test_request_context(json={"strategy_id": sid, "user_id": SETTLE, "zkp_data": fresh,
                                            "refresh_only": True, "leg_index": 0}):
            resp = fn(wallet=SETTLE)
    body, code = (resp if isinstance(resp, tuple) else (resp, 200))
    assert code == 200 and body.get_json()["leg_index"] == 0
    leg0 = StrategyLeg.query.filter_by(strategy_id=sid, leg_index=0).first()
    leg1 = StrategyLeg.query.filter_by(strategy_id=sid, leg_index=1).first()
    assert json.loads(leg0.zkp_data)["binder_hex"] == "ee" * 32 and leg0.settlement is None
    assert json.loads(leg1.zkp_data)["binder_hex"] == "cd" * 32


def test_a_relayed_withdraw_passes_only_the_proof_and_recipient(node):
    node["results"].append((_lines({"ok": True, "commit_sig": "C1", "spend_sig": "S9"}), 0))
    out = s.relay_withdraw({**_pkg(), "secret": "never-sent"}, SETTLE)
    assert out == {"ok": True, "commit_sig": "C1", "spend_sig": "S9"}
    sent = node["inputs"][0]
    assert sent["recipient"] == SETTLE and "secret" not in sent and "return_precommitment" not in sent

    node["results"].append((_lines({"ok": False, "code": "NEEDS_REPROOF", "error": "roots moved"}), 3))
    assert s.relay_withdraw(_pkg(), SETTLE)["code"] == "NEEDS_REPROOF"


def test_relay_uses_the_bundled_script_when_the_monorepo_copy_is_absent(node, monkeypatch, tmp_path):
    monkeypatch.setattr(s, "_meteora_script", lambda: tmp_path / "absent" / "execute-zk-meteora.mjs")
    node["results"].append((_lines({"ok": True, "commit_sig": "C3", "spend_sig": "S3"}), 0))
    assert s.relay_withdraw(_pkg(), SETTLE)["spend_sig"] == "S3"


def test_a_relayed_split_sends_its_commitments_and_no_recipient(node):
    node["results"].append((_lines({"ok": True, "commit_sig": "C2", "spend_sig": "S2"}), 0))
    out = s.relay_withdraw({**_pkg(circuit_index=12), "split_commitments_hex": ["aa" * 32] * 8})
    assert out["spend_sig"] == "S2"
    sent = node["inputs"][0]
    assert sent["split_commitments_hex"] == ["aa" * 32] * 8 and "recipient" not in sent
