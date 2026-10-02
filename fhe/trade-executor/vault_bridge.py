"""
Vault↔vault Li.Fi hop — Base ↔ Arbitrum, USDC / ETH (WETH).

Assumes the SOURCE executor wallet already holds the asset (client withdrew the note to it).
Bridges to `recipient` on the destination chain and waits for arrival.
"""
from __future__ import annotations

from typing import Any, Optional

from evm_chain_config import get_evm_chain_config

BASE_CHAIN_ID = 8453
ARBITRUM_CHAIN_ID = 42161
VAULT_BRIDGE_CHAIN_IDS = {BASE_CHAIN_ID, ARBITRUM_CHAIN_ID}
VAULT_BRIDGE_ASSETS = {"USDC", "ETH", "WETH"}

CHAIN_LABELS = {
    BASE_CHAIN_ID: "Base",
    ARBITRUM_CHAIN_ID: "Arbitrum",
}


def _norm_asset(asset: str) -> str:
    sym = str(asset or "").strip().upper()
    if sym == "WETH":
        return "ETH"
    return sym


def assert_vault_bridge_corridor(from_chain_id: int, to_chain_id: int, asset: str) -> str:
    a, b = int(from_chain_id), int(to_chain_id)
    if a == b:
        raise ValueError("vault bridge requires distinct source and destination chains")
    if a not in VAULT_BRIDGE_CHAIN_IDS or b not in VAULT_BRIDGE_CHAIN_IDS:
        raise ValueError(
            f"v1 vault bridge is Base↔Arbitrum only (got {a} → {b})"
        )
    sym = _norm_asset(asset)
    if sym not in {"USDC", "ETH"}:
        raise ValueError(f"vault bridge supports USDC and ETH only (got {asset})")
    return sym


def _token_for_lifi(chain_id: int, asset: str) -> str:
    """ERC-20 address for Li.Fi. ETH notes settle as WETH after vault withdraw."""
    cfg = get_evm_chain_config(chain_id)
    sym = _norm_asset(asset)
    if sym == "USDC":
        if not cfg.usdc:
            raise RuntimeError(f"USDC address missing for chain {chain_id}")
        return cfg.usdc
    # ETH / WETH → WETH
    if not cfg.weth:
        raise RuntimeError(f"WETH address missing for chain {chain_id}")
    return cfg.weth


def plan_vault_bridge(
    *,
    from_chain_id: int,
    to_chain_id: int,
    amount: int,
    asset: str,
    from_address: str,
    recipient: str,
) -> dict[str, Any]:
    """Quote-only Li.Fi plan (no tx)."""
    amount = int(amount)
    if amount <= 0:
        raise ValueError("amount must be positive base units")
    sym = assert_vault_bridge_corridor(from_chain_id, to_chain_id, asset)
    from_token = _token_for_lifi(from_chain_id, sym)
    to_token = _token_for_lifi(to_chain_id, sym)

    from lifi_executor import get_lifi_quote

    quote = get_lifi_quote(
        from_chain=str(from_chain_id),
        to_chain=str(to_chain_id),
        from_token=from_token,
        to_token=to_token,
        from_amount=amount,
        from_address=from_address,
        to_address=recipient,
    )
    estimate = quote.get("estimate") or {}
    to_amount = str(estimate.get("toAmount") or estimate.get("toAmountMin") or "")
    tool = None
    for step in quote.get("includedSteps") or []:
        tool = (step.get("toolDetails") or {}).get("name") or step.get("tool") or tool
    return {
        "ok": True,
        "pending": False,
        "profileId": "vault-bridge-base-arb-v1",
        "fromChainId": int(from_chain_id),
        "toChainId": int(to_chain_id),
        "fromLabel": CHAIN_LABELS.get(int(from_chain_id), str(from_chain_id)),
        "toLabel": CHAIN_LABELS.get(int(to_chain_id), str(to_chain_id)),
        "asset": sym,
        "amount": amount,
        "fromToken": from_token,
        "toToken": to_token,
        "fromAddress": from_address,
        "recipient": recipient,
        "toAmount": to_amount,
        "tool": tool,
        "hasTransactionRequest": bool(quote.get("transactionRequest")),
        "message": (
            f"Li.Fi quote ready: {sym} "
            f"{CHAIN_LABELS.get(int(from_chain_id))} → {CHAIN_LABELS.get(int(to_chain_id))}"
        ),
    }


def execute_vault_bridge(
    *,
    from_chain_id: int,
    to_chain_id: int,
    amount: int,
    asset: str,
    recipient: str,
    timeout: int = 600,
) -> dict[str, Any]:
    """
    Bridge from the SOURCE-chain executor wallet to `recipient` on the destination chain.
    Waits until Li.Fi reports destination receipt.
    """
    amount = int(amount)
    if amount <= 0:
        raise ValueError("amount must be positive base units")
    sym = assert_vault_bridge_corridor(from_chain_id, to_chain_id, asset)
    recipient = str(recipient).strip()
    if not recipient.startswith("0x") or len(recipient) != 42:
        raise ValueError("recipient must be an EVM address")

    from_token = _token_for_lifi(from_chain_id, sym)
    to_token = _token_for_lifi(to_chain_id, sym)
    from_cfg = get_evm_chain_config(from_chain_id)

    from lifi_executor import bridge_and_wait
    from evm_executor import get_web3, get_executor_account

    w3 = get_web3(from_chain_id)
    account = get_executor_account(w3, from_chain_id)

    result = bridge_and_wait(
        from_chain=str(from_chain_id),
        to_chain=str(to_chain_id),
        from_token=from_token,
        to_token=to_token,
        from_amount_wei=amount,
        recipient=recipient,
        rpc_url=from_cfg.rpc_url,
        timeout=timeout,
    )
    received = int(result.get("received_wei") or 0)
    return {
        "ok": True,
        "pending": False,
        "profileId": "vault-bridge-base-arb-v1",
        "fromChainId": int(from_chain_id),
        "toChainId": int(to_chain_id),
        "fromLabel": CHAIN_LABELS.get(int(from_chain_id), str(from_chain_id)),
        "toLabel": CHAIN_LABELS.get(int(to_chain_id), str(to_chain_id)),
        "asset": sym,
        "amount": amount,
        "fromToken": from_token,
        "toToken": to_token,
        "fromAddress": account.address,
        "recipient": recipient,
        "srcTx": result.get("src_tx"),
        "destTx": result.get("dest_tx"),
        "receivedWei": str(received),
        "message": (
            f"Bridged {sym} {CHAIN_LABELS.get(int(from_chain_id))} → "
            f"{CHAIN_LABELS.get(int(to_chain_id))}; deposit into the destination vault next."
        ),
    }
