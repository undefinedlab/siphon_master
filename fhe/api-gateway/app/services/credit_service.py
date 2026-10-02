from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.repository.models import ApiKey, AuditLog, CreditLedger
from app.errors import NotFound, Conflict


def post_entry(
    db: Session,
    key_row: ApiKey,
    *,
    kind: str,
    amount_minor: int,
    reason: str | None,
    request_id: str,
    subaccount_id: str | None = None,
) -> int:
    """Append one ledger entry and move the cached balance in the same transaction.

    Caller must already hold the ApiKey row lock (SELECT ... FOR UPDATE) when concurrent writes are
    possible. Returns the new balance. Signed `amount_minor`: positive credits, negative debits.
    `subaccount_id` attributes the entry to one tenant, which is what makes per-tenant spend caps
    derivable from this table instead of from a drift-prone counter.
    """
    balance_before = int(key_row.balance_minor or 0)
    balance_after = balance_before + int(amount_minor)
    if balance_after < 0:
        raise Conflict("Credit entry would take the balance below zero.")

    key_row.balance_minor = balance_after
    db.add(
        CreditLedger(
            api_key_id=key_row.id,
            subaccount_id=subaccount_id,
            kind=kind,
            amount_minor=int(amount_minor),
            balance_after=balance_after,
            reason=reason,
            request_id=request_id,
        )
    )
    return balance_after


def sum_by_kind(db: Session, api_key_id: str, kind: str) -> int:
    """SQL aggregate over typed ledger columns — not a Python sum over JSON audit detail."""
    total = (
        db.query(func.coalesce(func.sum(CreditLedger.amount_minor), 0))
        .filter(CreditLedger.api_key_id == api_key_id, CreditLedger.kind == kind)
        .scalar()
    )
    return int(total or 0)


def ledger_balance(db: Session, api_key_id: str) -> int:
    """Authoritative balance recomputed from the ledger."""
    total = (
        db.query(func.coalesce(func.sum(CreditLedger.amount_minor), 0))
        .filter(CreditLedger.api_key_id == api_key_id)
        .scalar()
    )
    return int(total or 0)


def verify_balance(db: Session, api_key_id: str) -> tuple[int, int]:
    """Return (cached_balance, ledger_balance) so drift is detectable by ops and tests."""
    row = db.query(ApiKey).filter_by(id=api_key_id).first()
    if not row:
        raise NotFound("API key not found.")
    return int(row.balance_minor or 0), ledger_balance(db, api_key_id)


def grant(db: Session, api_key_id: str, amount_minor: int, reason: str, request_id: str) -> dict:
    """Atomic credit grant: ledger entry + balance move + immutable AuditLog.

    Raises NotFound (404) if the key doesn't exist, Conflict (409) if it is inactive.
    """
    key_row = db.query(ApiKey).filter_by(id=api_key_id).with_for_update().first()
    if not key_row:
        raise NotFound("API key not found.")

    if key_row.status != "active":
        raise Conflict(f"API key is not active (status={key_row.status}).")

    balance_before = int(key_row.balance_minor or 0)
    balance_after = post_entry(
        db,
        key_row,
        kind="grant",
        amount_minor=amount_minor,
        reason=reason,
        request_id=request_id,
    )

    # Security trail only — billing arithmetic now lives in credit_ledger.
    audit_event = AuditLog(
        actor="admin",
        action="credit.grant",
        target=api_key_id,
        result="granted",
        request_id=request_id,
        detail={
            "amount_minor": amount_minor,
            "reason": reason,
            "balance_before": balance_before,
            "balance_after": balance_after,
        },
    )
    db.add(audit_event)
    db.flush()

    return {
        "api_key_id": api_key_id,
        "amount_minor": amount_minor,
        "balance_minor": balance_after,
        "reason": reason,
        "granted_at": (audit_event.created_at or datetime.now(timezone.utc)).isoformat(),
    }
