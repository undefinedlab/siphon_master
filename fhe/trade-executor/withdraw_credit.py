"""Prepaid withdrawal-fee credit: top up occasionally, debit silently per relayed withdrawal.

The v3 VaultKernel has NO fee module — `getFeeInfo`/`quoteWithdrawFee` do not exist on it and the
kernel is immutable — so a withdrawal fee cannot be taken on-chain the way the v2 vaults took it
(Vault/WithdrawFee.sol). The only place left to charge is the relayer, which is where this lives.

Two properties drive the design:

  * It is SOFT, and that is a deliberate protocol guarantee, not an oversight. `VaultKernel.spend()`
    is `external` with no access control precisely so "a TEE outage can never prevent a user from
    withdrawing". Anyone can submit their own proof and pay nothing. This charges the convenience
    of the relayer, and must never be described as enforcement.

  * It is PREPAID, not per-withdrawal. A fee transfer from the user's public wallet immediately
    before their shielded withdrawal is relayed lets an observer correlate the two by timing and
    link a public identity to an otherwise unlinkable exit. An occasional top-up decouples the
    payment from the withdrawal, which is the whole reason the vault exists.

Disabled by default (V3_WITHDRAW_FEE_ENABLED). With it off, relaySpend behaves exactly as before,
so the executor and the frontend can deploy in either order without a window where withdrawals
fail — the failure mode of getting that wrong is every user unable to exit.
"""
from __future__ import annotations

import os

from web3 import Web3

from evm_chain_config import get_evm_chain_config

# Same shape arming_fee.py verifies: a plain ERC-20 transfer to the chain's executor wallet.
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

USDC_DECIMALS = 6


def enabled() -> bool:
    """Off unless explicitly switched on. See the module note on deploy ordering."""
    return (os.getenv("V3_WITHDRAW_FEE_ENABLED", "0").strip().lower()
            in ("1", "true", "yes", "on"))


def fee_wei() -> int:
    """Flat fee per relayed withdrawal, in USDC minor units. Default $0.05."""
    raw = (os.getenv("V3_WITHDRAW_FEE_USDC", "0.05") or "0.05").strip()
    try:
        return int(round(float(raw) * 10 ** USDC_DECIMALS))
    except (TypeError, ValueError):
        return 50_000


def _norm(addr: str) -> str:
    return (addr or "").strip().lower()


def _same(a: str, b: str) -> bool:
    return bool(a) and bool(b) and _norm(a) == _norm(b)


def validate_topup_transfer(transfer: dict, *, wallet: str, collector: str, usdc: str) -> int:
    """Validate already-decoded facts. Pure, so the failure modes are exhaustively testable.

    Returns the amount credited. Overpayment is credited in full — the ledger records what the
    chain actually moved, never what was asked for.
    """
    if int(transfer.get("status", 0)) != 1:
        raise ValueError("top-up transaction reverted")
    if not _same(transfer.get("token", ""), usdc):
        raise ValueError("top-up did not call the configured USDC contract")
    if not _same(transfer.get("sender", ""), wallet):
        raise ValueError("top-up sender does not match the authenticated wallet")
    if not _same(transfer.get("recipient", ""), collector):
        raise ValueError("top-up recipient is not the configured collector")
    amount = int(transfer.get("amount", 0))
    if amount <= 0:
        raise ValueError("top-up moved no USDC")
    return amount


def balance_wei(wallet: str, chain_id: int) -> int:
    """Signed sum of the ledger: credits minus debits. Never negative in practice."""
    from database import WithdrawCredit
    rows = WithdrawCredit.query.filter_by(
        wallet=_norm(wallet), chain_id=int(chain_id)
    ).all()
    total = 0
    for r in rows:
        amt = int(r.amount_wei)
        total += amt if r.kind == "topup" else -amt
    return total


def record_topup(wallet: str, chain_id: int, tx_hash: str, amount_wei: int) -> int:
    """Credit a verified transfer. The UNIQUE tx_hash is what stops the same transfer being
    credited twice; catching the IntegrityError is the check, not a pre-read (which races)."""
    from database import db, WithdrawCredit
    row = WithdrawCredit(
        wallet=_norm(wallet), chain_id=int(chain_id), kind="topup",
        amount_wei=str(int(amount_wei)), tx_hash=_norm(tx_hash),
    )
    db.session.add(row)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise ValueError("this transaction has already been credited")
    return balance_wei(wallet, chain_id)


def debit(wallet: str, chain_id: int, amount_wei: int, ref: str | None = None) -> None:
    """Consume credit. Append-only, so a concurrent debit cannot be lost the way a running
    total would be."""
    from database import db, WithdrawCredit
    db.session.add(WithdrawCredit(
        wallet=_norm(wallet), chain_id=int(chain_id), kind="debit",
        amount_wei=str(int(amount_wei)), ref=ref,
    ))
    db.session.commit()


def verify_topup(wallet: str, chain_id: int, tx_hash: str) -> dict:
    """Fetch and verify a confirmed USDC transfer, then credit it."""
    if not wallet:
        raise ValueError("wallet authentication is required")
    if not tx_hash:
        raise ValueError("top-up transaction hash is required")
    chain = get_evm_chain_config(int(chain_id))
    w3 = Web3(Web3.HTTPProvider(chain.rpc_url, request_kwargs={"timeout": 10}))
    receipt = w3.eth.get_transaction_receipt(tx_hash)
    # Read the Transfer log, not the calldata — see arming_fee.erc20_transfer_facts. A
    # 7702-delegated wallet pays through a batcher and decoding tx.input cannot see it.
    import arming_fee
    collector = collector_address(chain_id)
    amount = validate_topup_transfer(
        arming_fee.erc20_transfer_facts(
            receipt, token=chain.usdc, sender=wallet, recipient=collector
        ),
        wallet=wallet, collector=collector, usdc=chain.usdc,
    )
    new_balance = record_topup(wallet, chain_id, tx_hash, amount)
    return {"credited_wei": str(amount), "balance_wei": str(new_balance)}


def collector_address(chain_id: int) -> str:
    """Where top-ups are sent. Defaults to the arming-fee executor wallet so there is one
    place money arrives, not two."""
    import arming_fee
    override = os.getenv(f"V3_WITHDRAW_FEE_COLLECTOR_{int(chain_id)}", "").strip()
    return override or arming_fee.executor_address(int(chain_id))
