"""Verify the USDC transfer that arms a strategy.

Arming is deliberately separate from the shielded vault. The connected wallet sends the arming
fee plus the fee for the execution window it asked for, as ONE USDC transfer to the chain's
executor wallet; the backend verifies that confirmed transaction before accepting the strategy.
No note, precommitment, approval, oracle quote, or vault write is involved.

An overpayment is accepted. That is what lets the browser and the executor deploy in either
order across the window-fee cutover (fee_config.WINDOW_FEE_ENABLED) instead of having to land in
the same breath — and the ledger records what actually arrived, not what was asked for.
"""
from __future__ import annotations

import os

from eth_utils import keccak
from web3 import Web3

import fee_calc
import fee_config as fc
from evm_chain_config import get_evm_chain_config

ERC20_TRANSFER_ABI = [{
    "inputs": [
        {"internalType": "address", "name": "to", "type": "address"},
        {"internalType": "uint256", "name": "value", "type": "uint256"},
    ],
    "name": "transfer",
    "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
    "stateMutability": "nonpayable",
    "type": "function",
}]

_EXECUTOR_DEFAULTS = {
    8453: "0x5830A431E6866B8F8a605625b0713D8190FB06bA",
    11155111: "0xc5b7b574EE84A9B59B475FE32Eaf908C246d3859",
}
_EXECUTOR_ENV = {
    8453: "BASE_EXECUTOR_ADDRESS",
    11155111: "ETH_SEPOLIA_EXECUTOR_ADDRESS",
    42161: "ARBITRUM_EXECUTOR_ADDRESS",
    998: "HYPEREVM_TESTNET_EXECUTOR_ADDRESS",
}


#: The arming leg alone, with no window priced in — the ledger splits the single transfer into
#: this plus the window remainder so the report matches the pricing sheet's line items.
ARMING_ONLY_USDC_WEI = int(round(fc.ARMING_USDC * 1_000_000))


def required_arming_fee_usdc_wei(window_hours: float = 0.0) -> int:
    """Arming + window, in USDC base units (6 decimals)."""
    return int(round(fee_calc.compute_arming_fee_usd(window_hours) * 1_000_000))


def window_hours_from_request(data: dict) -> float:
    """Execution window the strategy asked for, in hours. Absent/garbage means the shortest tier,
    matching the app's own duration parser."""
    try:
        return max(0.0, float(data.get("execution_window_sec") or 0) / 3600.0)
    except (TypeError, ValueError):
        return 0.0


def executor_address(chain_id: int) -> str:
    address = (
        os.getenv(_EXECUTOR_ENV.get(int(chain_id), ""), "").strip()
        or _EXECUTOR_DEFAULTS.get(int(chain_id), "")
    )
    if not address or not Web3.is_address(address):
        raise ValueError(f"executor address is not configured for chain {chain_id}")
    return Web3.to_checksum_address(address)


def _same_address(left: str, right: str) -> bool:
    try:
        return Web3.to_checksum_address(left) == Web3.to_checksum_address(right)
    except (TypeError, ValueError):
        return False


#: `Transfer(address,address,uint256)` — emitted by every ERC-20 transfer however it was invoked.
TRANSFER_TOPIC = "0x" + keccak(text="Transfer(address,address,uint256)").hex()


def _topic_address(topic) -> str:
    raw = topic.hex() if hasattr(topic, "hex") else str(topic)
    return Web3.to_checksum_address("0x" + raw[-40:])


def erc20_transfer_facts(receipt, *, token: str, sender: str, recipient: str) -> dict:
    """The ERC-20 transfer this transaction performed, read from its LOGS rather than its calldata.

    Decoding `tx.input` only sees a payment when the wallet called `token.transfer()` directly.
    An EIP-7702-delegated account — which is what MetaMask smart accounts are now — routes the
    same transfer through a batcher, so `tx.to` is not the token and the selector is not
    `transfer()`. The fee arrives correctly and verification rejects it with "Could not find any
    function with matching selector", which reads like a broken ABI rather than a wallet shape.

    Logs are also strictly stronger evidence: calldata says what was *asked for*, a Transfer log
    says the tokens actually moved. The log's `address` is checked against the configured token so
    a lookalike contract cannot forge one.
    """
    want = Web3.to_checksum_address(token)
    matches = []
    for log in receipt.get("logs", []) or []:
        topics = log.get("topics") or []
        if len(topics) != 3:
            continue
        head = topics[0].hex() if hasattr(topics[0], "hex") else str(topics[0])
        if not head.startswith("0x"):
            head = "0x" + head
        if head.lower() != TRANSFER_TOPIC.lower():
            continue
        if Web3.to_checksum_address(log["address"]) != want:
            continue
        data = log["data"]
        data = data.hex() if hasattr(data, "hex") else str(data)
        matches.append({
            "sender": _topic_address(topics[1]),
            "recipient": _topic_address(topics[2]),
            "amount": int(data, 16),
        })
    if not matches:
        raise ValueError("transaction transferred no tokens of the configured USDC contract")
    # Prefer the leg that actually pays the recipient from the wallet; otherwise hand the first
    # one to the validator so it produces its specific sender/recipient error, not a generic miss.
    best = next(
        (m for m in matches
         if _same_address(m["sender"], sender) and _same_address(m["recipient"], recipient)),
        matches[0],
    )
    return {"status": receipt["status"], "token": want, **best}


def validate_arming_transfer(
    transfer: dict, *, wallet: str, executor: str, usdc: str, required_wei: int | None = None
) -> dict:
    """Validate already-decoded transaction facts; kept pure for exhaustive tests.

    `required_wei` defaults to the bare arming fee (no window), which is what a caller that has
    no window to price should charge. The recorded amount is what the chain actually moved.
    """
    if required_wei is None:
        required_wei = required_arming_fee_usdc_wei()
    if int(transfer.get("status", 0)) != 1:
        raise ValueError("arming fee transaction reverted")
    if not _same_address(transfer.get("token", ""), usdc):
        raise ValueError("arming fee transaction did not call the configured USDC contract")
    if not _same_address(transfer.get("sender", ""), wallet):
        raise ValueError("arming fee transaction sender does not match strategy wallet")
    if not _same_address(transfer.get("recipient", ""), executor):
        raise ValueError("arming fee recipient is not the configured executor wallet")
    paid = int(transfer.get("amount", 0))
    if paid < required_wei:
        raise ValueError(
            f"arming fee must transfer at least {required_wei / 1_000_000:.2f} USDC "
            f"(arming + execution window); this transaction moved {paid / 1_000_000:.2f} USDC"
        )
    return {"amount_wei": str(paid), "asset": "USDC"}


def verify_arming_transfer(data: dict, wallet: str) -> dict:
    """Fetch and verify a confirmed ERC-20 transfer from the authenticated order wallet."""
    if not wallet:
        raise ValueError("wallet authentication is required when fees are enabled")
    try:
        chain_id = int(data.get("from_chain") or 8453)
    except (TypeError, ValueError):
        raise ValueError("valid source chain is required")
    tx_hash = str(data.get("arming_tx_hash") or "").strip()
    if not tx_hash:
        raise ValueError("arming transaction hash is required")

    chain = get_evm_chain_config(chain_id)
    w3 = Web3(Web3.HTTPProvider(chain.rpc_url, request_kwargs={"timeout": 10}))
    receipt = w3.eth.get_transaction_receipt(tx_hash)
    executor = executor_address(chain_id)
    result = validate_arming_transfer(
        erc20_transfer_facts(
            receipt, token=chain.usdc, sender=wallet, recipient=executor
        ),
        wallet=wallet,
        executor=executor,
        usdc=chain.usdc,
        required_wei=required_arming_fee_usdc_wei(window_hours_from_request(data)),
    )
    result.update({
        "tx_hash": tx_hash.lower(),
        "chain_id": chain_id,
        "executor": executor_address(chain_id),
    })
    return result
