"""Batches — one authorization over many recipients (payroll, payouts, settlement runs).

Today a 500-person payroll is 500 signed withdrawals. The batch is the unit the integrator
authorizes, is billed for, and polls; each entry becomes an Operation carrying `batch_id`, so
per-item state and per-item failure stay visible without collapsing back into N independent calls.

Partial failure is the normal case, not an exception: one bad recipient must not void the other 499.
A batch therefore rolls up to `submitted` -> `confirmed` only when every item is terminal, and
reports `failed` counts rather than aborting the run.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.errors import BadRequest, NotFound
from app.repository.models import Batch, Operation
from app.schemas.compliance import BusinessOperationState as S
from app.services import operation_service

MAX_BATCH_ITEMS = 500


def _now() -> datetime:
    return datetime.now(timezone.utc)


def create(
    db: Session,
    *,
    api_key_id: str,
    chain_id: int,
    asset: str,
    items: list[dict],
    subaccount_id: str | None = None,
    wallet: str | None = None,
    kind: str = "payout",
) -> Batch:
    """Create a batch and one Operation per item, all inside the caller's transaction."""
    if not items:
        raise BadRequest("A batch must contain at least one item.")
    if len(items) > MAX_BATCH_ITEMS:
        raise BadRequest(f"A batch may contain at most {MAX_BATCH_ITEMS} items (got {len(items)}).")

    total = 0
    for i, it in enumerate(items):
        amt = it.get("amount_minor")
        if not isinstance(amt, int) or isinstance(amt, bool) or amt <= 0:
            raise BadRequest(f"items[{i}].amount_minor must be a positive integer.")
        if not it.get("recipient"):
            raise BadRequest(f"items[{i}].recipient is required.")
        total += amt

    batch = Batch(
        api_key_id=api_key_id,
        subaccount_id=subaccount_id,
        kind=kind,
        state="created",
        chain_id=chain_id,
        asset=asset,
        item_count=len(items),
        total_amount_minor=total,
        wallet=wallet,
    )
    db.add(batch)
    db.flush()

    for it in items:
        operation_service.create(
            db,
            api_key_id=api_key_id,
            kind="withdrawal",
            subaccount_id=subaccount_id,
            batch_id=batch.id,
            chain_id=chain_id,
            asset=asset,
            amount_minor=int(it["amount_minor"]),
            recipient=it["recipient"],
            wallet=wallet,
            detail={"reference": it.get("reference")} if it.get("reference") else None,
        )

    return batch


def items(db: Session, batch_id: str) -> list[Operation]:
    return (
        db.query(Operation)
        .filter(Operation.batch_id == batch_id)
        .order_by(Operation.created_at, Operation.id)
        .all()
    )


def get_owned(db: Session, batch_id: str, api_key_id: str) -> Batch:
    row = db.query(Batch).filter_by(id=batch_id).first()
    if row is None or row.api_key_id != api_key_id:
        raise NotFound("Batch not found.")
    return row


def counts(db: Session, batch_id: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for op in items(db, batch_id):
        out[op.state] = out.get(op.state, 0) + 1
    return out


def refresh_state(db: Session, batch: Batch) -> Batch:
    """Roll item states up to the batch.

    A batch is only terminal when every item is terminal — and it is `confirmed` only if at least one
    item confirmed. All-failed rolls up to `failed` rather than a misleading `confirmed`.
    """
    ops = items(db, batch.id)
    if not ops:
        return batch

    states = [str(o.state) for o in ops]
    terminal = operation_service.TERMINAL

    if all(s in terminal for s in states):
        confirmed = sum(1 for s in states if s == S.confirmed)
        new_state = "confirmed" if confirmed else "failed"
    elif any(s == S.submitted for s in states):
        new_state = "submitted"
    elif any(s in (S.proving, S.queued, S.authorized) for s in states):
        new_state = "processing"
    else:
        new_state = "created"

    if batch.state != new_state:
        batch.state = new_state
        batch.updated_at = _now()
        db.flush()
    return batch


def public_view(db: Session, batch: Batch) -> dict:
    by_state = counts(db, batch.id)
    return {
        "batch_id": batch.id,
        "kind": batch.kind,
        "status": batch.state,
        "chain_id": batch.chain_id,
        "asset": batch.asset,
        "item_count": batch.item_count,
        "total_amount_minor": batch.total_amount_minor,
        "subaccount_id": batch.subaccount_id,
        "counts_by_state": by_state,
        "created_at": batch.created_at,
        "updated_at": batch.updated_at,
    }
