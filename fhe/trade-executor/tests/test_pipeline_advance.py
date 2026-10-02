"""Private multi-hop PIPELINE: validation + state machine (mock TEE prove)."""
from __future__ import annotations

import json
from unittest import mock

import pytest

from test_bridge_payout import A, ctx  # noqa: F401
import solana_devnet_strategy as s

SETTLE = "8xueCcQRMhKo5CtppfmxXar2LuVaHfiiN3VzhxepqNEg"


def _pkg(**over):
    p = {
        "venue": "meteora-dlmm", "proof_hex": "ab" * 256, "binder_hex": "cd" * 32,
        "publics": ["0"] * 25, "nullifiers_hex": ["11" * 32],
        "mint": "So11111111111111111111111111111111111111112", "settlement": SETTLE,
        "meteora_pool": "BY4cLgYMpE1AA5X5jiXHEMTrVkG7uhDvr6KxjU8YfCEZ", "circuit_index": 0,
        "return_precommitment": "123", "return_user_salt": "456",
        "solana_side": "sell_jlusdc", "meteora_pair": "jlusdc_sol",
    }
    p.update(over)
    return p


def _skeleton(**over):
    p = {
        "venue": "meteora-dlmm", "settlement": SETTLE,
        "meteora_pair": "jlusdc_sol", "solana_side": "sell_jlusdc",
        "meteora_pool": "pool",
    }
    p.update(over)
    return p


def test_pipeline_hop_skeleton_accepts_venue_without_proof():
    assert s.validate_pipeline_hop_skeleton(_skeleton()) is None
    assert "venue" in s.validate_pipeline_hop_skeleton({"settlement": SETTLE})
    assert "action" in s.validate_pipeline_hop_skeleton(
        {"venue": "jupiter-earn", "settlement": SETTLE, "asset_mint": "u", "jl_token_mint": "j"}
    )


NOTE = {"commitment": "77", "deposit_nonce": "3", "leaf_index": "12", "amount": "9",
        "mint": "2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu", "user_salt": "456"}
DONE = {"ok": True, "status": "EXECUTED", "spend_sig": "S1", "returned_note": NOTE}


def _pipeline_row(ctx, hops=2):
    from database import Strategy, StrategyLeg

    meta = {"pipeline": True, "sealed_bundle": "aa" * 32, "hop_cursor": 0, "hop_count": hops}
    row = Strategy(
        user_id=SETTLE, strategy_type="PIPELINE", asset_in="USDC", asset_out="SOL",
        amount=1.0, recipient_address=SETTLE, from_chain="900002", to_chain="900002",
        output_mode="vault", status="ARMED", leg_count=hops, eval_mode="pipeline",
        zkp_data=json.dumps(meta),
    )
    ctx.db.session.add(row)
    ctx.db.session.flush()
    ctx.db.session.add(StrategyLeg(
        strategy_id=row.id, leg_index=0, amount=1.0, eval_mode="pipeline",
        leg_kind="pipeline", zkp_data=json.dumps(_pkg(venue="jupiter-earn", action="enter",
                                                      asset_mint="u", jl_token_mint="j")),
        status="EXECUTED",
        settlement=json.dumps({"returned_note": NOTE, "ok": True}),
    ))
    for i in range(1, hops):
        ctx.db.session.add(StrategyLeg(
            strategy_id=row.id, leg_index=i, amount=1.0, eval_mode="pipeline",
            leg_kind="pipeline", zkp_data=json.dumps(_skeleton()), status="QUEUED",
        ))
    ctx.db.session.commit()
    return row.id


def test_advance_pipeline_proves_next_hop_and_settles(ctx, monkeypatch):
    from database import Strategy, StrategyLeg

    sid = _pipeline_row(ctx, hops=2)
    proved_pkg = _pkg()

    def fake_prove(strategy_id, hop_index, *, sealed_bundle, public_context):
        assert hop_index == 1
        assert sealed_bundle
        assert public_context["returned_note"]["commitment"] == "77"
        return {"ok": True, "package": proved_pkg}

    settle_calls = []

    def fake_settle(strategy, zkp, resume=None):
        settle_calls.append(zkp)
        return {**DONE, "settlement": DONE}

    monkeypatch.setattr("pipeline_tee.prove_pipeline_hop", fake_prove)
    monkeypatch.setattr(s, "settle", fake_settle)
    monkeypatch.setattr(s, "settlement_pubkey", lambda: SETTLE)

    out = s.advance_pipeline(sid)
    assert out.get("ok") or out.get("status") == "EXECUTED"
    hop1 = StrategyLeg.query.filter_by(strategy_id=sid, leg_index=1).first()
    assert hop1.status == "EXECUTED"
    assert json.loads(hop1.zkp_data)["binder_hex"] == proved_pkg["binder_hex"]
    assert settle_calls, "hop 1 was settled"
    parent = Strategy.query.get(sid)
    meta = json.loads(parent.zkp_data)
    assert meta["hop_cursor"] == 1


def test_advance_pipeline_marks_needs_reproof_without_failing_parent(ctx, monkeypatch):
    from database import Strategy, StrategyLeg

    sid = _pipeline_row(ctx, hops=2)

    monkeypatch.setattr(
        "pipeline_tee.prove_pipeline_hop",
        lambda *a, **k: {"ok": False, "code": "NEEDS_REPROOF", "error": "stale leaves"},
    )
    monkeypatch.setattr(s, "settlement_pubkey", lambda: SETTLE)

    out = s.advance_pipeline(sid)
    assert out.get("status") == "NEEDS_REPROOF"
    hop1 = StrategyLeg.query.filter_by(strategy_id=sid, leg_index=1).first()
    assert hop1.status == "PENDING"
    assert json.loads(hop1.settlement)["waiting"] == "NEEDS_REPROOF"
    assert Strategy.query.get(sid).status == "ARMED"
