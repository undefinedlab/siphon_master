"""Package gate for Solana Devnet Meteora settlement. No RPC."""
import solana_devnet_strategy as s


def _ok():
    return {
        "venue": "meteora-dlmm",
        "proof_hex": "ab" * 256,
        "binder_hex": "cd" * 32,
        "publics": ["0"] * 25,
        "nullifiers_hex": ["11" * 32],
        "mint": "So11111111111111111111111111111111111111112",
        "settlement": "F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH",
        "meteora_pool": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
        "circuit_index": 0,
    }


def test_package_accepts_meteora_spend():
    assert s.validate_meteora_zk_package(_ok()) is None


def test_package_rejects_legacy_pool_venue():
    pkg = _ok()
    pkg["venue"] = "siphon-pool-v1"
    assert "meteora-dlmm" in (s.validate_meteora_zk_package(pkg) or "")


def test_package_rejects_short_proof():
    pkg = _ok()
    pkg["proof_hex"] = "aa"
    assert s.validate_meteora_zk_package(pkg)


def test_resolve_side_from_assets():
    assert s.resolve_swap_side({"asset_in": "USDC", "asset_out": "SOL", "zkp_data": {}}) == "sell_usdc"
    assert s.resolve_swap_side({"asset_in": "SOL", "asset_out": "USDC", "zkp_data": {}}) == "sell_wsol"
