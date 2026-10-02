"""Package gate for Solana Devnet Jito stake settlement. No RPC."""
import solana_devnet_strategy as s

SETTLE = "F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH"
WSOL = "So11111111111111111111111111111111111111112"
JITO = "J1tos8mqbhdGcF3pgj4PCKyVjzWSURcpLZU7pPGHxSYi"


def _ok(action: str = "enter"):
    return {
        "venue": "jito-stake",
        "action": action,
        "proof_hex": "ab" * 256,
        "binder_hex": "cd" * 32,
        "publics": ["0"] * 25,
        "nullifiers_hex": ["11" * 32],
        "mint": WSOL if action == "enter" else JITO,
        "settlement": SETTLE,
        "jito_sol_mint": JITO,
        "stake_pool": "JitoY5pcAxWX6iyP2QdFwTznGb8A99PRCUCVVxB46WZ",
        "circuit_index": 0,
        "return_precommitment": "1",
        "return_user_salt": "2",
    }


def test_jito_package_accepts_enter():
    assert s.validate_jito_stake_zk_package(_ok("enter"), settlement=SETTLE, vault_output=True) is None


def test_jito_package_accepts_exit():
    assert s.validate_jito_stake_zk_package(_ok("exit"), settlement=SETTLE, vault_output=True) is None


def test_jito_package_rejects_bad_action():
    pkg = _ok()
    pkg["action"] = "restake"
    assert "action" in (s.validate_jito_stake_zk_package(pkg) or "")


def test_devnet_dispatch_includes_jito():
    assert s.validate_devnet_zk_package(_ok("enter"), settlement=SETTLE, vault_output=True) is None
