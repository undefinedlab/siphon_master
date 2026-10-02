"""Tests for Solana Devnet → Sepolia USDC test bridge."""
import solana_devnet_bridge as bridge


def test_describe_plan_is_usdc_test_bridge_and_pending():
    plan = bridge.describe_devnet_bridge_plan(
        amount=1_000_000,
        solana_owner="11111111111111111111111111111111",
        recipient="0x0000000000000000000000000000000000000001",
    )
    assert plan["testBridge"] is True
    assert plan["usdcOnly"] is True
    assert plan["asset"] == "USDC"
    assert plan["toChainId"] == bridge.custody_chain_id()
    assert plan["pending"] is True
    assert plan["ok"] is False
    assert "test_bridge_mint_usdc" in plan["steps"]
    assert plan["usdcToken"]
    assert plan["usdcToken"].lower() == bridge.CIRCLE_SEPOLIA_USDC.lower()
    assert plan["creditVia"] == "faucet_transfer"


def test_execute_without_token_raises():
    try:
        bridge.execute_devnet_bridge_mint(
            amount=1,
            solana_owner="11111111111111111111111111111111",
            recipient="0x0000000000000000000000000000000000000001",
            token="",
            private_key="",
        )
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "SEPOLIA_TEST_USDC" in str(exc) or "USDC" in str(exc)


def test_execute_without_key_returns_pending_plan():
    result = bridge.execute_devnet_bridge_mint(
        amount=1_000_000,
        solana_owner="11111111111111111111111111111111",
        recipient="0x0000000000000000000000000000000000000001",
        private_key="",
    )
    assert result["ok"] is False
    assert result["pending"] is True
    assert result["asset"] == "USDC"
    assert "key missing" in result["message"].lower() or "DEVNET_BRIDGE_KEY" in result["message"]
