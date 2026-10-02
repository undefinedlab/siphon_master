"""HyperEVM ↔ HyperCore USDC transfers (no Li.Fi).

HyperEVM → Core: approve Circle USDC to CoreDepositWallet, then deposit(amount, dex).
Core → HyperEVM: spot_transfer to USDC system address 0x2000…0000 (via hl_bridge).

Used when from_chain is HyperEVM Testnet (998) or mainnet HyperEVM (999).
"""
from __future__ import annotations

import os
import time
from typing import Optional

from web3 import Web3

# Circle native USDC + CoreDepositWallet (from Hyperliquid spotMeta / Chainstack docs).
HYPEREVM_TESTNET_USDC = "0x2B3370eE501B4a559b57D449569354196457D8Ab"
HYPEREVM_TESTNET_CORE_DEPOSIT = "0x0b80659a4076e9e93c7dbe0f10675a16a3e5c206"
HYPEREVM_MAINNET_USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f"
HYPEREVM_MAINNET_CORE_DEPOSIT = "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24"

USDC_SYSTEM_ADDRESS = "0x2000000000000000000000000000000000000000"
PERPS_DEX = 0
SPOT_DEX = 4294967295  # uint32 max

_ERC20_ABI = [
    {
        "inputs": [
            {"name": "spender", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "name": "approve",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
        ],
        "name": "allowance",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
]

_DEPOSIT_ABI = [
    {
        "inputs": [
            {"name": "amount", "type": "uint256"},
            {"name": "destinationDex", "type": "uint32"},
        ],
        "name": "deposit",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    }
]


def is_hyperevm_chain(chain_id: int) -> bool:
    return int(chain_id) in (998, 999)


def _addrs(chain_id: int) -> tuple[str, str]:
    cid = int(chain_id)
    if cid == 998:
        usdc = os.environ.get("HYPEREVM_TESTNET_USDC", HYPEREVM_TESTNET_USDC).strip()
        wallet = os.environ.get(
            "HYPEREVM_TESTNET_CORE_DEPOSIT_WALLET", HYPEREVM_TESTNET_CORE_DEPOSIT
        ).strip()
        return usdc, wallet
    if cid == 999:
        usdc = os.environ.get("HYPEREVM_USDC", HYPEREVM_MAINNET_USDC).strip()
        wallet = os.environ.get(
            "HYPEREVM_CORE_DEPOSIT_WALLET", HYPEREVM_MAINNET_CORE_DEPOSIT
        ).strip()
        return usdc, wallet
    raise ValueError(f"not a HyperEVM chain: {cid}")


def deposit_usdc_to_core(
    w3: Web3,
    account,
    chain_id: int,
    amount_wei: int,
    *,
    to_perps: bool = True,
    send_tx=None,
) -> str:
    """Approve + CoreDepositWallet.deposit — credits HyperCore perps (default) or spot.

    `send_tx` must be the executor's send_tx(w3, account, tx_params, label=...) helper.
    """
    if amount_wei <= 0:
        raise ValueError("amount_wei must be > 0")
    if send_tx is None:
        raise ValueError("send_tx required")

    usdc_addr, deposit_addr = _addrs(chain_id)
    usdc = w3.eth.contract(address=Web3.to_checksum_address(usdc_addr), abi=_ERC20_ABI)
    core = w3.eth.contract(address=Web3.to_checksum_address(deposit_addr), abi=_DEPOSIT_ABI)
    owner = Web3.to_checksum_address(account.address)
    spender = Web3.to_checksum_address(deposit_addr)

    allowance = usdc.functions.allowance(owner, spender).call()
    if allowance < amount_wei:
        approve_tx = usdc.functions.approve(spender, amount_wei).build_transaction({
            "from": owner,
        })
        send_tx(w3, account, approve_tx, label="hyperevm-usdc-approve")

    dex = PERPS_DEX if to_perps else SPOT_DEX
    deposit_tx = core.functions.deposit(amount_wei, dex).build_transaction({"from": owner})
    tx = send_tx(w3, account, deposit_tx, label="hyperevm-core-deposit")
    # Brief wait for HyperCore credit.
    time.sleep(float(os.environ.get("HYPEREVM_CORE_CREDIT_WAIT_SEC", "3")))
    return tx


def withdraw_usdc_to_hyperevm(amount_usd: float) -> dict:
    """HyperCore spot/perps → HyperEVM via spot_transfer to USDC system address."""
    import hyperliquid_client

    return hyperliquid_client.spot_transfer_to_evm(amount_usd)
