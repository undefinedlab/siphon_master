"""Managed accounts — Siphon's answer to enclave-custodied wallets.

This is what closes the gap that made Siphon unusable over HTTP alone: `POST /v1/deposits` takes a
`precommitment` from the caller, so an integrator had to generate note secrets, run BN254 Poseidon,
build Merkle proofs and produce Groth16 proofs themselves. Here the enclave keeper does all of it
and the gateway stores only public values.

Two invariants this module exists to hold:

1. **The gateway never holds spendable material.** Only `precommitment`, `commitment` and
   `nullifier_hash` are persisted. `KeeperClient._assert_no_secrets` is the tripwire; this layer
   simply never asks for anything else.
2. **A note index is allocated exactly once.** Keeper derivation is deterministic on index, so
   handing the same index to two concurrent deposits mints the SAME commitment twice — the second
   insert is a duplicate leaf whose note can never be independently spent. `allocate_index` takes a
   row lock for that reason, and `uq_managed_note_index` is the database-level backstop.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.adapters.keeper import KeeperClient
from app.errors import Conflict, NotFound
from app.repository.models import ManagedAccount, ManagedNote


def _now() -> datetime:
    return datetime.now(timezone.utc)


def keeper_ref(api_key_id: str, external_ref: str) -> str:
    """The derivation reference handed to the enclave.

    NAMESPACED BY API KEY on purpose. If this were the caller's `external_ref` alone, two
    integrators who both name an account "customer-1" would derive byte-identical notes and could
    spend each other's funds. This string is the isolation boundary between tenants.
    """
    return f"{api_key_id}:{external_ref}"


def create(
    db: Session,
    keeper: KeeperClient,
    *,
    api_key_id: str,
    external_ref: str,
    subaccount_id: str | None = None,
    label: str | None = None,
) -> ManagedAccount:
    existing = (
        db.query(ManagedAccount)
        .filter_by(api_key_id=api_key_id, external_ref=external_ref)
        .first()
    )
    if existing is not None:
        raise Conflict(f"A managed account with external_ref '{external_ref}' already exists.")

    ref = keeper_ref(api_key_id, external_ref)
    derived = keeper.derive_account(ref)

    row = ManagedAccount(
        api_key_id=api_key_id,
        subaccount_id=subaccount_id,
        external_ref=external_ref,
        keeper_ref=ref,
        fingerprint=derived["fingerprint"],
        owner_address=derived.get("owner_address"),
        control_mode="enclave_custody",
        label=label,
    )
    db.add(row)
    db.flush()
    return row


def get_owned(db: Session, account_id: str, api_key_id: str) -> ManagedAccount:
    row = db.query(ManagedAccount).filter_by(id=account_id).first()
    if (
        row is None
        or row.api_key_id != api_key_id
        or row.control_mode != "enclave_custody"
    ):
        raise NotFound("Managed account not found.")
    return row


def resolve(db: Session, api_key_id: str, ref: str) -> ManagedAccount:
    """Accept either our id or the integrator's own external_ref."""
    row = (
        db.query(ManagedAccount)
        .filter(
            ManagedAccount.api_key_id == api_key_id,
            ManagedAccount.control_mode == "enclave_custody",
            (ManagedAccount.id == ref) | (ManagedAccount.external_ref == ref),
        )
        .first()
    )
    if row is None:
        raise NotFound("Managed account not found.")
    return row


def allocate_index(db: Session, account: ManagedAccount) -> int:
    """Reserve the next note index under a row lock.

    The lock is not defensive style — keeper derivation is a pure function of (master, ref, index),
    so two callers granted the same index receive identical note material. `with_for_update()`
    serializes them on Postgres; SQLite (tests) is single-writer already.
    """
    locked = (
        db.query(ManagedAccount)
        .filter_by(id=account.id)
        .with_for_update()
        .first()
    )
    if locked is None:
        raise NotFound("Managed account not found.")
    index = int(locked.next_note_index or 0)
    locked.next_note_index = index + 1
    db.flush()
    return index


def allocate_note(
    db: Session,
    keeper: KeeperClient,
    *,
    account: ManagedAccount,
    chain_id: int,
    asset: str,
    amount_minor: int,
    scope: int,
    nonce: int,
    operation_id: str | None = None,
) -> ManagedNote:
    """Derive one note in the enclave and persist only its public half."""
    if amount_minor <= 0:
        raise Conflict("amount_minor must be positive.")
    if account.status != "active":
        raise Conflict(f"Managed account is {account.status}.")

    index = allocate_index(db, account)
    derived = keeper.allocate_note(
        keeper_ref=account.keeper_ref,
        index=index,
        amount=amount_minor,
        scope=scope,
        nonce=nonce,
    )

    note = ManagedNote(
        account_id=account.id,
        api_key_id=account.api_key_id,
        operation_id=operation_id,
        note_index=index,
        chain_id=chain_id,
        asset=asset,
        amount_minor=amount_minor,
        label=derived["label"],
        precommitment=derived["precommitment"],
        commitment=derived["commitment"],
        nullifier_hash=derived["nullifier_hash"],
        status="pending",
    )
    db.add(note)
    db.flush()
    return note


def confirm_note(db: Session, note: ManagedNote, tx_hash: str | None = None) -> ManagedNote:
    if note.status == "spent":
        raise Conflict("Note is already spent.")
    note.status = "confirmed"
    if tx_hash:
        note.tx_hash = tx_hash
    note.updated_at = _now()
    db.flush()
    return note


def balance_minor(db: Session, account_id: str, *, chain_id: int | None = None,
                  asset: str | None = None) -> int:
    """Confirmed, unspent value. Pending notes are excluded — an unmined deposit is not a balance."""
    q = db.query(func.coalesce(func.sum(ManagedNote.amount_minor), 0)).filter(
        ManagedNote.account_id == account_id,
        ManagedNote.status == "confirmed",
    )
    if chain_id is not None:
        q = q.filter(ManagedNote.chain_id == chain_id)
    if asset is not None:
        q = q.filter(ManagedNote.asset == asset)
    return int(q.scalar() or 0)


def notes(db: Session, account_id: str, *, status: str | None = None, limit: int = 100) -> list[ManagedNote]:
    q = db.query(ManagedNote).filter(ManagedNote.account_id == account_id)
    if status:
        q = q.filter(ManagedNote.status == status)
    return q.order_by(ManagedNote.note_index).limit(limit).all()


def public_view(db: Session, account: ManagedAccount) -> dict:
    return {
        "account_id": account.id,
        "external_ref": account.external_ref,
        "label": account.label,
        "status": account.status,
        "owner_address": account.owner_address,
        "fingerprint": account.fingerprint,
        "subaccount_id": account.subaccount_id,
        "note_count": db.query(func.count(ManagedNote.id))
                        .filter(ManagedNote.account_id == account.id).scalar() or 0,
        "balance_minor": balance_minor(db, account.id),
        "created_at": account.created_at,
    }


def note_view(note: ManagedNote) -> dict:
    """Public projection. No nullifier, no secret — by construction those never reached this DB."""
    return {
        "note_id": note.id,
        "index": note.note_index,
        "chain_id": note.chain_id,
        "asset": note.asset,
        "amount_minor": note.amount_minor,
        "label": note.label,
        "commitment": note.commitment,
        "precommitment": note.precommitment,
        "nullifier_hash": note.nullifier_hash,
        "status": note.status,
        "tx_hash": note.tx_hash,
        "created_at": note.created_at,
    }
