"""On-chain compliance fees → product entitlements ($0.50 / wallet / year each).

Products (separate payments — one does not cover the other):
  - kyt_year_v1: zkMe transaction-risk KYT (Level 1 screening)
  - kyc_year_v1: zkMe zkKYC identity widget (Level 2)

Supports ETH or USDC to ASP_COMPLIANCE_VAULT.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from web3 import Web3

import config
from db import (
    get_kyc_entitlement,
    get_kyt_entitlement,
    has_active_kyc_entitlement,
    has_active_kyt_entitlement,
    upsert_kyc_entitlement,
    upsert_kyt_entitlement,
)
from util import normalize_address

log = logging.getLogger("aspv2.compliance_fee")

PRODUCT_KYT = "kyt_year_v1"
PRODUCT_KYC = "kyc_year_v1"
VALID_PRODUCTS = frozenset({PRODUCT_KYT, PRODUCT_KYC})

_USDC_TRANSFER_TOPIC = bytes.fromhex(
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
)
_TX_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")


class FeeNotPaid(Exception):
    """Transaction does not satisfy the fee requirement."""


class FeeAlreadyPaid(Exception):
    """Wallet already has an active entitlement for this product."""


def normalize_product(product: str | None) -> str:
    p = (product or PRODUCT_KYT).strip()
    if p not in VALID_PRODUCTS:
        raise ValueError(f"product must be one of {sorted(VALID_PRODUCTS)}")
    return p


def _entitlement_row(db: Session, wallet: str, product: str):
    if product == PRODUCT_KYC:
        return get_kyc_entitlement(db, wallet)
    return get_kyt_entitlement(db, wallet)


def _has_active(db: Session, wallet: str, product: str) -> bool:
    if product == PRODUCT_KYC:
        return has_active_kyc_entitlement(db, wallet)
    return has_active_kyt_entitlement(db, wallet)


def entitlement_status(
    db: Session, wallet: str, chain_id: int | None = None, *, product: str | None = None
) -> dict:
    """Public check payload for GET /compliance-fee/check.

    Two independent selectors, and both matter:

    `chain_id` selects the vault. Without it the caller gets whatever single vault the box has
    configured, which is right for a one-chain deployment and wrong the moment there are two: the
    UI sends the user's fee to whatever address this returns, so answering with another chain's
    vault is answering with an address the user's chain cannot pay into. Optional so existing
    single-chain callers keep working unchanged.

    `product` selects which entitlement is being asked about. KYT (transaction screening) and KYC
    (identity) are priced and paid separately, so one product's payment must never read as the
    other's - defaulting to KYT keeps pre-KYC callers unchanged.
    """
    prod = normalize_product(product)
    addr = normalize_address(wallet) or ""
    row = _entitlement_row(db, addr, prod) if addr else None
    active = _has_active(db, addr, prod) if addr else False
    expires = None
    if row is not None:
        exp = row.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        expires = exp.isoformat()
    days = (
        config.KYC_ENTITLEMENT_DAYS if prod == PRODUCT_KYC else config.KYT_ENTITLEMENT_DAYS
    )
    return {
        "paid": active,
        "wallet": addr or None,
        "expiresAt": expires if active else (expires if row else None),
        "active": active,
        "vault": config.compliance_vault(chain_id) or None,
        "chainId": chain_id,
        "feeUsdc": config.COMPLIANCE_FEE_USDC,
        "feeWei": config.COMPLIANCE_FEE_WEI,
        "entitlementDays": days,
        "product": prod,
    }


def _w3(chain_id: int) -> Web3:
    rpc = config.rpc_url_for(chain_id)
    if not rpc:
        raise FeeNotPaid(f"No RPC configured for chain {chain_id}")
    return Web3(Web3.HTTPProvider(rpc))


def _topic_addr(topic) -> str:
    raw = topic.hex() if hasattr(topic, "hex") else str(topic)
    raw = raw[2:] if raw.startswith("0x") else raw
    return "0x" + raw[-40:].lower()


def verify_fee_payment(
    db: Session,
    *,
    chain_id: int,
    tx_hash: str,
    wallet: str,
    product: str | None = None,
) -> dict:
    """Verify on-chain payment and upsert entitlement. Caller commits."""
    prod = normalize_product(product)
    addr = normalize_address(wallet)
    if not addr:
        raise FeeNotPaid("wallet must be a 0x-prefixed 20-byte address")
    txh = (tx_hash or "").strip().lower()
    if not _TX_HASH_RE.match(txh):
        raise FeeNotPaid("txHash must be 0x + 64 hex chars")

    if _has_active(db, addr, prod):
        row = _entitlement_row(db, addr, prod)
        raise FeeAlreadyPaid(
            f"Wallet {addr[:10]}… already covered for {prod} until "
            f"{row.expires_at.isoformat() if row else '?'}"
        )

    # Per-chain: this is the address the payment is checked AGAINST, so it must be the same one
    # /compliance-fee/check handed the user. Verifying against another chain's vault would reject
    # every correct payment.
    vault = config.compliance_vault(chain_id)
    if not vault:
        raise FeeNotPaid(
            f"No compliance vault configured for chain {chain_id} "
            f"(set ASP_COMPLIANCE_VAULT_{chain_id})"
        )

    w3 = _w3(chain_id)
    try:
        receipt = w3.eth.get_transaction_receipt(txh)
        tx = w3.eth.get_transaction(txh)
    except Exception as exc:
        raise FeeNotPaid(f"Cannot fetch transaction: {exc}") from exc

    if receipt is None or tx is None:
        raise FeeNotPaid("Transaction not found or not yet mined")
    if int(receipt.get("status") or 0) != 1:
        raise FeeNotPaid("Transaction reverted")

    required = max(0, int(getattr(config, "CHAIN_MIN_CONFIRMATIONS", 0)))
    if required > 0:
        block_number = int(receipt["blockNumber"])
        confirmations = int(w3.eth.block_number) - block_number + 1
        if confirmations < required:
            raise FeeNotPaid(
                f"fee transaction has {confirmations}/{required} confirmations"
            )

    tx_from = (tx.get("from") or "").lower()
    if tx_from != addr:
        raise FeeNotPaid(
            f"Transaction sender {tx_from[:10]}… does not match wallet {addr[:10]}…"
        )

    if config.COMPLIANCE_FEE_WEI <= 0 and config.COMPLIANCE_FEE_USDC <= 0:
        raise FeeNotPaid("compliance fee amounts are misconfigured (both <= 0)")

    upsert = upsert_kyc_entitlement if prod == PRODUCT_KYC else upsert_kyt_entitlement

    tx_to = (tx.get("to") or "").lower()
    tx_value = int(tx.get("value") or 0)
    if tx_to == vault and config.COMPLIANCE_FEE_WEI > 0 and tx_value >= config.COMPLIANCE_FEE_WEI:
        try:
            upsert(
                db,
                wallet=addr,
                tx_hash=txh,
                chain_id=chain_id,
                token="ETH",
                amount_raw=str(tx_value),
            )
        except ValueError as exc:
            raise FeeNotPaid(str(exc)) from exc
        except IntegrityError as exc:
            # The unique index on tx_hash is the replay guard: two concurrent verifies of the
            # same payment race here, and the loser must read as a clean rejection rather than a
            # 500. origin/main dropped this; test_r9_f2_integrity_error_mapped_to_consumed pins it.
            raise FeeNotPaid(f"tx_hash already consumed for a {prod} fee payment") from exc
        log.info("%s entitlement paid (ETH): wallet=%s tx=%s", prod, addr[:10], txh[:10])
        return {"ok": True, "token": "ETH", "amount": str(tx_value), "product": prod}

    usdc_addr = (config.USDC_ADDRESS_BY_CHAIN.get(chain_id) or "").lower()
    if usdc_addr:
        for log_entry in receipt.get("logs") or []:
            log_contract = (log_entry.get("address") or "").lower()
            if log_contract != usdc_addr:
                continue
            topics = list(log_entry.get("topics") or [])
            if len(topics) < 3:
                continue
            t0 = topics[0]
            t0_bytes = t0 if isinstance(t0, (bytes, bytearray)) else bytes.fromhex(
                (t0.hex() if hasattr(t0, "hex") else str(t0)).replace("0x", "")
            )
            if t0_bytes != _USDC_TRANSFER_TOPIC:
                continue
            log_from = _topic_addr(topics[1])
            log_to = _topic_addr(topics[2])
            if log_from != addr or log_to != vault:
                continue
            data = log_entry.get("data") or b""
            if hasattr(data, "hex"):
                amount = int(data.hex(), 16)
            else:
                amount = int(str(data).replace("0x", ""), 16)
            if amount >= config.COMPLIANCE_FEE_USDC and config.COMPLIANCE_FEE_USDC > 0:
                try:
                    upsert(
                        db,
                        wallet=addr,
                        tx_hash=txh,
                        chain_id=chain_id,
                        token="USDC",
                        amount_raw=str(amount),
                    )
                except ValueError as exc:
                    raise FeeNotPaid(str(exc)) from exc
                except IntegrityError as exc:
                    raise FeeNotPaid(
                        f"tx_hash already consumed for a {prod} fee payment"
                    ) from exc
                log.info(
                    "%s entitlement paid (USDC): wallet=%s tx=%s", prod, addr[:10], txh[:10]
                )
                return {"ok": True, "token": "USDC", "amount": str(amount), "product": prod}

    raise FeeNotPaid(
        "Transaction does not contain a valid fee payment of >=$0.50 to the compliance vault"
    )
