"""Self-custody account registrations: public metadata only, never signing or note secrets."""
from __future__ import annotations

import hashlib

from sqlalchemy import func
from sqlalchemy.orm import Session
from web3 import Web3

from app.errors import BadRequest, Conflict, NotFound
from app.repository.models import ManagedAccount, ManagedNote


def _normalize_wallet(address: str) -> str:
    from app.reuse import is_solana_address

    if is_solana_address((address or "").strip()):
        return address.strip()  # base58: case is part of the key
    if not Web3.is_address(address or ""):
        raise BadRequest("wallet_address must be an EVM address or a Solana (base58) address.")
    return Web3.to_checksum_address(address)


def create(
    db: Session,
    *,
    api_key_id: str,
    external_ref: str,
    wallet_address: str,
    subaccount_id: str | None = None,
    label: str | None = None,
) -> ManagedAccount:
    existing = db.query(ManagedAccount).filter_by(
        api_key_id=api_key_id, external_ref=external_ref
    ).first()
    if existing is not None:
        raise Conflict(f"An account with external_ref '{external_ref}' already exists.")

    wallet = _normalize_wallet(wallet_address)
    public_ref = f"self:{api_key_id}:{external_ref}"
    row = ManagedAccount(
        api_key_id=api_key_id,
        subaccount_id=subaccount_id,
        external_ref=external_ref,
        # These legacy columns stay populated until the custody-table split is fully migrated.
        # Both values are derived exclusively from public identifiers and confer no authority.
        keeper_ref=public_ref,
        fingerprint=hashlib.sha256(f"{public_ref}:{wallet.lower()}".encode()).hexdigest(),
        owner_address=wallet,
        control_mode="self_custody",
        label=label,
    )
    db.add(row)
    db.flush()
    return row


def resolve(db: Session, api_key_id: str, ref: str) -> ManagedAccount:
    row = db.query(ManagedAccount).filter(
        ManagedAccount.api_key_id == api_key_id,
        ManagedAccount.control_mode == "self_custody",
        (ManagedAccount.id == ref) | (ManagedAccount.external_ref == ref),
    ).first()
    if row is None:
        raise NotFound("Account not found.")
    return row


def public_view(db: Session, account: ManagedAccount) -> dict:
    note_count = db.query(func.count(ManagedNote.id)).filter(
        ManagedNote.account_id == account.id
    ).scalar() or 0
    return {
        "account_id": account.id,
        "external_ref": account.external_ref,
        "label": account.label,
        "status": account.status,
        "control_mode": "self_custody",
        "wallet_address": account.owner_address,
        "api_key_can_spend": False,
        "subaccount_id": account.subaccount_id,
        "note_count": int(note_count),
        "created_at": account.created_at,
    }
