"""Pending-admit outbox — screen stores sealed userSalt so deposit watcher can derive label."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from db import PendingAdmit
from salt_crypto import open_user_salt, seal_user_salt
from util import normalize_depositor

log = logging.getLogger("aspv2.pending_admit")


class PendingAdmitConflict(ValueError):
    """Same commitment claimed by a different depositor, or salt overwrite blocked."""


def upsert_pending_admit(
    db: Session,
    *,
    chain_id: int,
    commitment: str,
    user_salt: str | int,
    depositor: str | None = None,
    vault_address: str | None = None,
    label: str | None = None,
) -> PendingAdmit:
    commitment = str(commitment).strip()
    dep = normalize_depositor(depositor, chain_id)
    if not commitment:
        raise ValueError("commitment required")
    plain = str(user_salt).strip()
    sealed = seal_user_salt(plain)
    row = db.execute(
        select(PendingAdmit).where(
            PendingAdmit.chain_id == chain_id,
            PendingAdmit.commitment == commitment,
        )
    ).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if row:
        if row.status == "admitted":
            return row
        existing_dep = normalize_depositor(row.depositor, chain_id)
        if existing_dep and dep and existing_dep != dep:
            raise PendingAdmitConflict(
                "pending admit for commitment already owned by another depositor"
            )
        if existing_dep and not dep:
            raise PendingAdmitConflict("pending admit exists; depositor required to update")

        # F-2 / r3: freeze sealed salt while pending — never overwrite (incl. decrypt fail).
        if row.status == "pending" and row.user_salt:
            try:
                existing_plain = open_user_salt(row.user_salt)
            except ValueError as exc:
                raise PendingAdmitConflict(
                    "pending userSalt is immutable (sealed; decrypt failed)"
                ) from exc
            if existing_plain != plain:
                raise PendingAdmitConflict("pending userSalt is immutable")
            row.depositor = dep or existing_dep
            row.vault_address = vault_address or row.vault_address
            row.label = label or row.label
            row.updated_at = now
            return row

        row.user_salt = sealed
        row.depositor = dep or existing_dep
        row.vault_address = vault_address or row.vault_address
        row.label = label or row.label
        row.status = "pending"
        row.error = None
        row.updated_at = now
        return row
    if not dep:
        raise ValueError("depositor required for pending admit")
    row = PendingAdmit(
        chain_id=chain_id,
        commitment=commitment,
        depositor=dep,
        vault_address=vault_address,
        user_salt=sealed,
        label=label,
        status="pending",
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    return row


def read_pending_salt(row: PendingAdmit) -> str:
    return open_user_salt(row.user_salt)


def get_pending_by_commitment(db: Session, chain_id: int, commitment: str) -> PendingAdmit | None:
    return db.execute(
        select(PendingAdmit).where(
            PendingAdmit.chain_id == chain_id,
            PendingAdmit.commitment == str(commitment).strip(),
        )
    ).scalar_one_or_none()


def list_pending(db: Session, *, chain_id: int | None = None, limit: int = 100) -> list[PendingAdmit]:
    q = select(PendingAdmit).where(PendingAdmit.status == "pending").order_by(PendingAdmit.created_at.asc())
    if chain_id is not None:
        q = q.where(PendingAdmit.chain_id == chain_id)
    return list(db.execute(q.limit(limit)).scalars().all())


def mark_pending_admitted(db: Session, row: PendingAdmit, *, tx_hash: str, label: str) -> None:
    row.status = "admitted"
    row.tx_hash = tx_hash
    row.label = label
    row.error = None
    row.updated_at = datetime.now(timezone.utc)
    row.user_salt = ""


def mark_pending_failed(db: Session, row: PendingAdmit, error: str) -> None:
    row.status = "failed"
    row.error = error[:500]
    row.user_salt = ""  # wipe salt on fail
    row.updated_at = datetime.now(timezone.utc)


def cancel_pending(db: Session, row: PendingAdmit, reason: str) -> None:
    row.status = "cancelled"
    row.error = reason[:500]
    row.user_salt = ""
    row.updated_at = datetime.now(timezone.utc)
