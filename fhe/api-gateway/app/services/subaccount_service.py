"""Subaccounts — per-tenant isolation inside one integrator's API key.

A platform serving 10,000 end users cannot mint 10,000 API keys, and must not let one user's
activity consume another's budget. A subaccount carries its own spend cap and rate budget while
billing rolls up to the owning key.

Spend is DERIVED from `credit_ledger` rows scoped to the subaccount, never tracked in a counter
column. A counter drifts the first time a transaction rolls back after it was incremented; a sum
over an append-only ledger cannot. This is the same reasoning that motivated the ledger itself.
"""
from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.errors import Conflict, Forbidden, NotFound
from app.repository.models import ApiKey, CreditLedger, Subaccount


def create(
    db: Session,
    *,
    api_key_id: str,
    external_id: str,
    label: str | None = None,
    spend_cap_minor: int | None = None,
    rate_limit_per_min: int | None = None,
) -> Subaccount:
    existing = (
        db.query(Subaccount)
        .filter_by(api_key_id=api_key_id, external_id=external_id)
        .first()
    )
    if existing is not None:
        raise Conflict(f"A subaccount with external_id '{external_id}' already exists.")

    if spend_cap_minor is not None and spend_cap_minor < 0:
        raise Conflict("spend_cap_minor must be >= 0.")

    row = Subaccount(
        api_key_id=api_key_id,
        external_id=external_id,
        label=label,
        spend_cap_minor=spend_cap_minor,
        rate_limit_per_min=rate_limit_per_min,
    )
    db.add(row)
    db.flush()
    return row


def get_owned(db: Session, subaccount_id: str, api_key_id: str) -> Subaccount:
    row = db.query(Subaccount).filter_by(id=subaccount_id).first()
    if row is None or row.api_key_id != api_key_id:
        raise NotFound("Subaccount not found.")
    return row


def resolve(db: Session, api_key_id: str, ref: str | None) -> Subaccount | None:
    """Resolve by our id or by the integrator's own external_id — both address the same tenant."""
    if not ref:
        return None
    row = (
        db.query(Subaccount)
        .filter(
            Subaccount.api_key_id == api_key_id,
            (Subaccount.id == ref) | (Subaccount.external_id == ref),
        )
        .first()
    )
    if row is None:
        raise NotFound("Subaccount not found.")
    return row


def spent_minor(db: Session, subaccount_id: str) -> int:
    """Total already DEBITED against this subaccount, as a positive number."""
    total = (
        db.query(func.coalesce(func.sum(CreditLedger.amount_minor), 0))
        .filter(CreditLedger.subaccount_id == subaccount_id, CreditLedger.amount_minor < 0)
        .scalar()
    )
    return abs(int(total or 0))


def reserved_minor(db: Session, subaccount_id: str) -> int:
    """Authorized but not yet settled — in-flight operations that will debit when they confirm.

    Without this the cap does not bind at all: authorization only *checks* the cap while the debit
    happens at settlement, so before anything settles `spent` is 0 and an unlimited number of
    batches each pass the check. Counting non-terminal operations closes that window without
    needing a reserve-and-refund ledger.
    """
    from app.repository.models import Operation
    from app.services.operation_service import TERMINAL_VALUES

    total = (
        db.query(func.coalesce(func.sum(Operation.amount_minor), 0))
        .filter(
            Operation.subaccount_id == subaccount_id,
            Operation.state.notin_(tuple(TERMINAL_VALUES)),
        )
        .scalar()
    )
    return int(total or 0)


def committed_minor(db: Session, subaccount_id: str) -> int:
    """Everything counting against the cap: settled debits plus in-flight authorizations."""
    return spent_minor(db, subaccount_id) + reserved_minor(db, subaccount_id)


def remaining_minor(db: Session, sub: Subaccount) -> int | None:
    """Headroom under the cap, or None when uncapped."""
    if sub.spend_cap_minor is None:
        return None
    return max(0, int(sub.spend_cap_minor) - committed_minor(db, sub.id))


def assert_can_spend(db: Session, sub: Subaccount | None, amount_minor: int) -> None:
    """Fail-closed cap enforcement, called BEFORE a fund-moving side effect."""
    if sub is None:
        return
    if sub.status != "active":
        raise Forbidden(f"Subaccount is {sub.status}.")
    if sub.spend_cap_minor is None:
        return
    remaining = remaining_minor(db, sub)
    if amount_minor > (remaining or 0):
        from app.errors import InsufficientQuota

        raise InsufficientQuota(
            f"Subaccount spend cap exceeded: {amount_minor} requested, {remaining} remaining."
        )


def charge(
    db: Session,
    *,
    api_key: ApiKey,
    sub: Subaccount | None,
    amount_minor: int,
    reason: str,
    request_id: str,
) -> int:
    """Debit the key's balance, attributing the entry to the subaccount when one is in scope."""
    from app.services import credit_service

    assert_can_spend(db, sub, amount_minor)
    balance = credit_service.post_entry(
        db,
        api_key,
        kind="debit",
        amount_minor=-abs(int(amount_minor)),
        reason=reason,
        request_id=request_id,
        subaccount_id=sub.id if sub else None,
    )
    return balance


def public_view(db: Session, sub: Subaccount) -> dict:
    return {
        "subaccount_id": sub.id,
        "external_id": sub.external_id,
        "label": sub.label,
        "status": sub.status,
        "spend_cap_minor": sub.spend_cap_minor,
        "spent_minor": spent_minor(db, sub.id),
        "reserved_minor": reserved_minor(db, sub.id),
        "remaining_minor": remaining_minor(db, sub),
        "rate_limit_per_min": sub.rate_limit_per_min,
        "created_at": sub.created_at,
    }
