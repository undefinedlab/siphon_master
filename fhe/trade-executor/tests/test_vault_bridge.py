"""Unit tests for vault_bridge corridor (no live Li.Fi)."""
import pytest

import vault_bridge


def test_corridor_base_arb_usdc():
    assert vault_bridge.assert_vault_bridge_corridor(8453, 42161, "USDC") == "USDC"
    assert vault_bridge.assert_vault_bridge_corridor(42161, 8453, "eth") == "ETH"
    assert vault_bridge.assert_vault_bridge_corridor(8453, 42161, "WETH") == "ETH"


def test_corridor_rejects_same_chain_and_solana():
    with pytest.raises(ValueError, match="distinct"):
        vault_bridge.assert_vault_bridge_corridor(8453, 8453, "USDC")
    with pytest.raises(ValueError, match="Base↔Arbitrum"):
        vault_bridge.assert_vault_bridge_corridor(8453, 900001, "USDC")
    with pytest.raises(ValueError, match="USDC and ETH"):
        vault_bridge.assert_vault_bridge_corridor(8453, 42161, "WBTC")
