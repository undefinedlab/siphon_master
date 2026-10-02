"""Unit tests for Jupiter SOL/USDC bootstrap helpers (no live Jupiter calls)."""

from __future__ import annotations

import jupiter_solana as jup


def test_mint_pair_sides():
    assert jup.mint_pair("LIMIT_SELL") == (jup.SOL_MINT, jup.USDC_MINT)
    assert jup.mint_pair("LIMIT_BUY") == (jup.USDC_MINT, jup.SOL_MINT)


def test_describe_plan():
    plan = jup.describe_sol_usdc_limit_plan(
        amount=100_000_000,
        trigger_price_usd=150.0,
        side="LIMIT_SELL",
        user_pubkey="11111111111111111111111111111111",
    )
    assert plan["settlement"] == "jupiter-public-bootstrap"
    assert plan["steps"][0] == "faucet_or_fund_wallet"
    assert "private" in plan["privacyNote"].lower() or "Public" in plan["privacyNote"]


def test_execute_fill_builds_without_claiming(monkeypatch):
    monkeypatch.setattr(
        jup,
        "quote_swap",
        lambda **kwargs: {"outAmount": "1", "inputMint": jup.SOL_MINT},
    )
    monkeypatch.setattr(
        jup,
        "build_swap_transaction",
        lambda **kwargs: {"swapTransaction": "AQID"},
    )
    result = jup.execute_solana_strategy_fill(
        {
            "side": "LIMIT_SELL",
            "amount": 1000,
            "recipient": "11111111111111111111111111111111",
        },
        180.0,
    )
    assert result["ok"] is False
    assert result["pending"] is True
    assert result["swapTransaction"] == "AQID"
