import intent_bridge


def test_solana_hop_is_pending_and_never_claims_transactions():
    result = intent_bridge.execute_intent_hop(
        900002,
        8453,
        1_000_000,
        "USDC",
        "0x0000000000000000000000000000000000000001",
    )

    assert result["ok"] is False
    assert result["pending"] is True
    assert [step["status"] for step in result["stepStatus"]] == [
        "pending",
        "blocked",
        "blocked",
        "blocked",
    ]
    assert result["stepStatus"][0]["runtime"] == "solana-v1"
    assert all(step["ok"] is False for step in result["stepStatus"])


def test_base_to_solana_hop_stays_pending_ordered_steps():
    result = intent_bridge.execute_intent_hop(
        8453,
        900002,
        1_000_000,
        "USDC",
        "11111111111111111111111111111111",
    )
    assert result["ok"] is False
    assert result["pending"] is True
    names = [step["step"] for step in result["stepStatus"]]
    assert names == [
        "withdraw_source_vault",
        "public_bridge_hop",
        "deposit_dest_vault",
        "asp_screen_dest",
    ]
    assert result["stepStatus"][0]["status"] == "pending"
    assert result["stepStatus"][1]["status"] == "blocked"
    assert result["destRuntime"] == "solana-v1"


def test_evm_hop_stops_before_lifi_without_confirmed_withdrawal(monkeypatch):
    called = []
    monkeypatch.setattr(
        intent_bridge,
        "_public_bridge_hop",
        lambda **kwargs: called.append(kwargs) or {"status": "completed", "ok": True},
    )

    result = intent_bridge.execute_intent_hop(
        8453,
        11155111,
        1_000_000,
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000001",
    )

    assert result["stepStatus"][0]["status"] == "pending"
    assert called == []


def test_wallet_fund_hop_skips_solana_vault_and_targets_base(monkeypatch):
    monkeypatch.setattr(
        intent_bridge,
        "_quote_solana_usdc_to_evm",
        lambda **kwargs: {
            "step": "public_bridge_hop",
            "status": "pending",
            "ok": False,
            "pending": True,
            "message": "quote stub",
            "quoteAvailable": True,
            "toolUrl": "https://li.fi/widget",
            "toChainId": kwargs.get("to_chain_id"),
        },
    )
    result = intent_bridge.execute_wallet_fund_hop(
        from_chain_id=900002,
        to_chain_id=8453,
        amount=1_000_000,
        asset="USDC",
        recipient="0x0000000000000000000000000000000000000001",
        solana_owner="11111111111111111111111111111111",
    )
    assert result["wrapperCut"] is True
    assert result["usdcOnly"] is True
    assert result["profileId"] == intent_bridge.WALLET_FUND_PROFILE_ID
    assert result["destRuntime"] == "evm-v1"
    assert [s["step"] for s in result["stepStatus"]] == [
        "source_wallet",
        "public_bridge_hop",
        "deposit_dest_vault",
        "asp_screen_dest",
    ]
    assert result["stepStatus"][0]["status"] == "completed"
    assert result["stepStatus"][0]["runtime"] == "solana-wallet"
    assert result["stepStatus"][2]["clientAction"] == "depositV3"
    assert result["stepStatus"][3]["status"] == "blocked"


def test_wallet_fund_hop_targets_arbitrum(monkeypatch):
    monkeypatch.setattr(
        intent_bridge,
        "_quote_solana_usdc_to_evm",
        lambda **kwargs: {
            "step": "public_bridge_hop",
            "status": "pending",
            "ok": False,
            "pending": True,
            "message": "quote stub arb",
            "quoteAvailable": True,
            "toChainId": 42161,
        },
    )
    result = intent_bridge.execute_wallet_fund_hop(
        from_chain_id=900001,
        to_chain_id=42161,
        amount=1_000_000,
        asset="USDC",
        recipient="0x0000000000000000000000000000000000000001",
        solana_owner="11111111111111111111111111111111",
    )
    assert result["toChainId"] == 42161
    assert result["stepStatus"][2]["chainId"] == 42161
    assert result["stepStatus"][2]["destUsdc"] == intent_bridge.ARBITRUM_USDC


def test_wallet_fund_hop_rejects_sol_asset():
    try:
        intent_bridge.execute_wallet_fund_hop(
            from_chain_id=900001,
            to_chain_id=8453,
            amount=1,
            asset="SOL",
            recipient="0x0000000000000000000000000000000000000001",
            solana_owner="11111111111111111111111111111111",
        )
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "USDC only" in str(exc)


def test_wallet_fund_hop_rejects_sepolia_dest():
    try:
        intent_bridge.execute_wallet_fund_hop(
            from_chain_id=900002,
            to_chain_id=11155111,
            amount=1,
            asset="USDC",
            recipient="0x0000000000000000000000000000000000000001",
            solana_owner="11111111111111111111111111111111",
        )
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "Base" in str(exc) or "Arbitrum" in str(exc)
