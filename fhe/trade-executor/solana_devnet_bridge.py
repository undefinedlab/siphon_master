"""Devnet Solana → Sepolia USDC test bridge.

Solana Devnet has no Li.Fi route to Sepolia. This adapter credits Circle Sepolia USDC
(or a mintable Siphon test USDC) 1:1 for the declared Solana Devnet USDC amount.
Labeled as a test bridge — does not debit Phantom until an escrow hop exists.
"""

from __future__ import annotations

import os
from typing import Any, Optional

SEPOLIA_CHAIN_ID = 11155111
ANVIL_CHAIN_ID = 31337

# Circle USDC on Ethereum Sepolia (6 decimals). Vault depositV3 uses this address.
CIRCLE_SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"

_MINT_ABI = [
    {
        "inputs": [
            {"name": "to", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "name": "mint",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    }
]

_ERC20_ABI = [
    {
        "inputs": [
            {"name": "to", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "name": "transfer",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [{"name": "account", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
]


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def custody_chain_id() -> int:
    raw = _env("DEVNET_VAULT_CHAIN_ID") or _env("NEXT_PUBLIC_DEVNET_VAULT_CHAIN_ID") or str(
        SEPOLIA_CHAIN_ID
    )
    try:
        n = int(raw)
    except ValueError:
        return SEPOLIA_CHAIN_ID
    return n if n > 0 else SEPOLIA_CHAIN_ID


def _test_usdc_token() -> str:
    return (
        _env("SEPOLIA_TEST_USDC")
        or _env("NEXT_PUBLIC_SEPOLIA_TEST_USDC")
        or _env("DEVNET_USDC_TOKEN")
        or _env("ETH_SEPOLIA_USDC")
        or CIRCLE_SEPOLIA_USDC
    )


def _uses_faucet_transfer(token: str) -> bool:
    mode = _env("DEVNET_USDC_CREDIT_MODE", "").lower()
    if mode in ("transfer", "faucet"):
        return True
    if mode == "mint":
        return False
    return token.lower() == CIRCLE_SEPOLIA_USDC.lower()


def describe_devnet_bridge_plan(
    *,
    amount: int,
    solana_owner: str,
    recipient: str,
) -> dict[str, Any]:
    """`amount` is USDC base units (6 decimals)."""
    if amount <= 0:
        raise ValueError("amount must be a positive integer in USDC base units (6 decimals)")
    token = _test_usdc_token()
    chain_id = custody_chain_id()
    chain_label = "Anvil" if chain_id == ANVIL_CHAIN_ID else "Sepolia"
    credit_via = "faucet_transfer" if _uses_faucet_transfer(token) else "mint"
    return {
        "profileId": "solana-devnet-usdc-test-bridge-v1",
        "testBridge": True,
        "usdcOnly": True,
        "ok": False,
        "pending": True,
        "fromChainId": 900002,
        "toChainId": chain_id,
        "solanaOwner": solana_owner,
        "recipient": recipient,
        "amount": int(amount),
        "asset": "USDC",
        "usdcToken": token or None,
        "creditVia": credit_via,
        "steps": [
            "source_solana_devnet_usdc",
            "test_bridge_mint_usdc",
            "deposit_dest_vault",
        ],
        "message": (
            f"Devnet test bridge: credit {chain_label} USDC 1:1 for Solana Devnet USDC "
            f"({credit_via}), then depositV3 into the {chain_label} vault. "
            "Does not debit Phantom. Not a production bridge."
        ),
        "clientNext": (
            "POST /solana/devnetBridge/execute to credit test USDC, then deposit USDC in the dashboard."
        ),
    }


def execute_devnet_bridge_mint(
    *,
    amount: int,
    solana_owner: str,
    recipient: str,
    rpc_url: Optional[str] = None,
    token: Optional[str] = None,
    private_key: Optional[str] = None,
) -> dict[str, Any]:
    """Credit Sepolia USDC on the Devnet custody chain to `recipient`."""
    chain_id = custody_chain_id()
    if not recipient.startswith("0x") or len(recipient) != 42:
        raise ValueError("recipient must be an EVM address")
    if not solana_owner:
        raise ValueError("solana_owner is required")
    if amount <= 0:
        raise ValueError("amount must be a positive integer in USDC base units (6 decimals)")

    token_addr = (token if token is not None else _test_usdc_token()).strip()
    if not token_addr.startswith("0x") or len(token_addr) != 42:
        raise ValueError(
            "SEPOLIA_TEST_USDC / NEXT_PUBLIC_SEPOLIA_TEST_USDC must be set to Sepolia USDC "
            "(Circle) or a mintable test USDC ERC-20."
        )

    plan = describe_devnet_bridge_plan(
        amount=amount, solana_owner=solana_owner, recipient=recipient
    )
    # Re-bind plan token when caller overrides.
    plan = {**plan, "usdcToken": token_addr, "creditVia": (
        "faucet_transfer" if _uses_faucet_transfer(token_addr) else "mint"
    )}

    key = (private_key or _env("DEVNET_BRIDGE_KEY") or _env("EVM_EXECUTOR_KEY")).strip()
    if not key:
        return {
            **plan,
            "ok": False,
            "pending": True,
            "status": "pending",
            "message": "Mint/credit key missing (set DEVNET_BRIDGE_KEY). Plan only — no credit submitted.",
        }

    if chain_id == ANVIL_CHAIN_ID:
        rpc = (
            rpc_url
            or _env("ANVIL_RPC")
            or _env("NEXT_PUBLIC_ANVIL_RPC_URL")
            or "http://127.0.0.1:8545"
        )
    else:
        rpc = (
            rpc_url
            or _env("ETH_SEPOLIA_RPC")
            or _env("ETH_RPC_URL")
            or "https://ethereum-sepolia-rpc.publicnode.com"
        )

    try:
        from web3 import Web3
    except ImportError as exc:
        raise RuntimeError(f"web3 required for Devnet bridge credit: {exc}") from exc

    w3 = Web3(Web3.HTTPProvider(rpc))
    try:
        from web3.middleware import ExtraDataToPOAMiddleware

        w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
    except Exception:
        try:
            from web3.middleware import geth_poa_middleware

            w3.middleware_onion.inject(geth_poa_middleware, layer=0)
        except Exception:
            pass

    account = w3.eth.account.from_key(key)
    to = Web3.to_checksum_address(recipient)
    token_checksum = Web3.to_checksum_address(token_addr)
    nonce = w3.eth.get_transaction_count(account.address)
    gas_price = w3.eth.gas_price
    chain_label = "Anvil" if chain_id == ANVIL_CHAIN_ID else "Sepolia"
    use_transfer = _uses_faucet_transfer(token_addr)

    if use_transfer:
        contract = w3.eth.contract(address=token_checksum, abi=_ERC20_ABI)
        bal = int(contract.functions.balanceOf(account.address).call())
        if bal < int(amount):
            return {
                **plan,
                "ok": False,
                "pending": True,
                "status": "pending",
                "message": (
                    f"Faucet wallet holds {bal} USDC base units; need {amount}. "
                    f"Fund {account.address} with Sepolia USDC, then retry."
                ),
                "minter": account.address,
                "usdcToken": token_addr,
            }
        tx = contract.functions.transfer(to, int(amount)).build_transaction(
            {
                "from": account.address,
                "nonce": nonce,
                "gas": 100_000,
                "maxFeePerGas": gas_price,
                "maxPriorityFeePerGas": min(gas_price, w3.to_wei(1, "gwei")),
                "chainId": chain_id,
            }
        )
        credit_verb = "credited (faucet transfer)"
    else:
        contract = w3.eth.contract(address=token_checksum, abi=_MINT_ABI)
        tx = contract.functions.mint(to, int(amount)).build_transaction(
            {
                "from": account.address,
                "nonce": nonce,
                "gas": 120_000,
                "maxFeePerGas": gas_price,
                "maxPriorityFeePerGas": min(gas_price, w3.to_wei(1, "gwei")),
                "chainId": chain_id,
            }
        )
        credit_verb = "minted"

    signed = account.sign_transaction(tx)
    raw = getattr(signed, "rawTransaction", None) or signed.raw_transaction
    tx_hash = w3.eth.send_raw_transaction(raw)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    ok = receipt.status == 1
    return {
        **plan,
        "ok": ok,
        "pending": not ok,
        "status": "completed" if ok else "failed",
        "mintTx": tx_hash.hex(),
        "minter": account.address,
        "amount": int(amount),
        "usdcToken": token_addr,
        "toChainId": chain_id,
        "message": (
            f"Test USDC {credit_verb} on {chain_label} — deposit USDC in the dashboard (depositV3)."
            if ok
            else f"USDC credit transaction failed on {chain_label}."
        ),
        "clientNext": f"depositV3 with token USDC on chain {chain_id}",
        "clientAction": "depositV3",
    }
