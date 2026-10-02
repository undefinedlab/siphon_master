"""Package gate for Solana Devnet Jupiter Earn settlement. No RPC."""
import solana_devnet_strategy as s

SETTLE = "F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH"
USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
JL = "2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu"


def _ok(action: str = "enter"):
    return {
        "venue": "jupiter-earn",
        "action": action,
        "proof_hex": "ab" * 256,
        "binder_hex": "cd" * 32,
        "publics": ["0"] * 25,
        "nullifiers_hex": ["11" * 32],
        "mint": USDC if action == "enter" else JL,
        "settlement": SETTLE,
        "asset_mint": USDC,
        "jl_token_mint": JL,
        "lending_program": "7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3",
        "circuit_index": 0,
        "return_precommitment": "1",
        "return_user_salt": "2",
    }


def test_earn_package_accepts_enter():
    assert s.validate_jupiter_earn_zk_package(_ok("enter"), settlement=SETTLE, vault_output=True) is None


def test_earn_package_accepts_exit():
    assert s.validate_jupiter_earn_zk_package(_ok("exit"), settlement=SETTLE, vault_output=True) is None


def test_earn_package_rejects_bad_action():
    pkg = _ok()
    pkg["action"] = "borrow"
    assert "action" in (s.validate_jupiter_earn_zk_package(pkg) or "")


def test_earn_package_rejects_wrong_settlement():
    err = s.validate_jupiter_earn_zk_package(_ok(), settlement="x" * 44, vault_output=True) or ""
    assert "another wallet" in err


def test_devnet_dispatch_routes_venues():
    assert s.validate_devnet_zk_package(_ok("enter"), settlement=SETTLE, vault_output=True) is None
    meteora = {
        "venue": "meteora-dlmm",
        "proof_hex": "ab" * 256,
        "binder_hex": "cd" * 32,
        "publics": ["0"] * 25,
        "nullifiers_hex": ["11" * 32],
        "mint": USDC,
        "settlement": SETTLE,
        "meteora_pool": "pool111111111111111111111111111111111111111",
        "circuit_index": 0,
        "return_precommitment": "1",
        "return_user_salt": "2",
    }
    assert s.validate_devnet_zk_package(meteora, settlement=SETTLE, vault_output=True) is None
    bad = _ok()
    bad["venue"] = "raydium"
    assert "venue" in (s.validate_devnet_zk_package(bad) or "")
    jito = {
        "venue": "jito-stake",
        "action": "enter",
        "proof_hex": "ab" * 256,
        "binder_hex": "cd" * 32,
        "publics": ["0"] * 25,
        "nullifiers_hex": ["11" * 32],
        "mint": "So11111111111111111111111111111111111111112",
        "settlement": SETTLE,
        "jito_sol_mint": "J1tos8mqbhdGcF3pgj4PCKyVjzWSURcpLZU7pPGHxSYi",
        "circuit_index": 0,
        "return_precommitment": "1",
        "return_user_salt": "2",
    }
    assert s.validate_devnet_zk_package(jito, settlement=SETTLE, vault_output=True) is None
