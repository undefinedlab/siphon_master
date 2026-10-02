"""Shared EVM gas, fee, and RPC-balance synchronization policy."""

import time
from typing import Callable, Optional


ZK_WITHDRAW_GAS_FLOOR = 2_000_000
SWAP_GAS_FLOOR = 750_000
TOKEN_VAULT_GAS_FLOOR = 1_500_000
NATIVE_VAULT_GAS_FLOOR = 1_500_000

_CHAIN_PRIORITY_GWEI = {
    8453: 0.001,
    42161: 0.001,
    11155111: 2.0,
}


def fee_params(w3, chain_id: int) -> dict:
    base_fee = w3.eth.get_block("latest")["baseFeePerGas"]
    priority_gwei = _CHAIN_PRIORITY_GWEI.get(chain_id, 2.0)
    priority = w3.to_wei(priority_gwei, "gwei")
    max_fee = max(base_fee * 2 + priority, priority * 2)
    return {"maxPriorityFeePerGas": priority, "maxFeePerGas": max_fee}


def wait_for_sufficient_balance(
    w3,
    address: str,
    required_wei: int,
    *,
    attempts: int = 1,
    poll_seconds: float = 1.0,
    on_wait: Optional[Callable[[int, int, int], None]] = None,
) -> int:
    """Wait until an RPC replica reports enough balance for a transaction."""
    balance = 0
    attempts = max(1, int(attempts))
    for attempt in range(attempts):
        balance = int(w3.eth.get_balance(address))
        if balance >= required_wei:
            return balance
        if attempt < attempts - 1:
            if on_wait:
                on_wait(balance, attempt + 1, attempts)
            time.sleep(poll_seconds)
    return balance
