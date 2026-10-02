"""Operations — the durable, pollable record of one asynchronous fund-moving action.

Every fund-moving flow creates an Operation at intent time and transitions it through
`BusinessOperationState`. Two properties matter and are enforced here rather than by convention:

1. **Transitions are validated.** An illegal jump (e.g. `confirmed` -> `proving`) raises rather than
   silently corrupting the record an integrator is polling. Terminal states are terminal.
2. **Every transition emits an event.** Webhook fan-out hangs off `transition()`, so a new caller
   cannot add a state change that silently fails to notify.

Ownership: every read is scoped by api_key_id and returns NotFound (never 403) on a miss, matching
`deps/authz.require_owner` — a caller must not be able to probe for the existence of another
integrator's operation.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.errors import Conflict, NotFound
from app.repository.models import Operation
from app.schemas.compliance import BusinessOperationState as S

# Legal transitions. Anything not listed is rejected.
_TRANSITIONS: dict[str, set[str]] = {
    S.created: {S.awaiting_deposit, S.screening, S.compliance_pending, S.ready, S.denied, S.failed, S.revoked},
    S.awaiting_deposit: {S.screening, S.ready, S.submitted, S.failed, S.revoked},
    S.screening: {S.compliance_pending, S.ready, S.denied, S.failed},
    S.compliance_pending: {S.ready, S.denied, S.failed, S.revoked},
    S.ready: {S.authorized, S.denied, S.failed, S.revoked},
    S.authorized: {S.proving, S.queued, S.submitted, S.failed, S.revoked},
    S.proving: {S.queued, S.submitted, S.failed},
    S.queued: {S.submitted, S.failed},
    S.submitted: {S.confirmed, S.failed, S.ragequit_submitted},
    S.ragequit_submitted: {S.ragequit_confirmed, S.failed},
    # Terminal.
    S.confirmed: set(),
    S.denied: set(),
    S.failed: set(),
    S.revoked: set(),
    S.ragequit_confirmed: set(),
}

TERMINAL = {s for s, nxt in _TRANSITIONS.items() if not nxt}

# Plain wire strings for the terminal states. ALWAYS use this when comparing against a value read
# from the DB or building a SQL filter: `str(S.failed)` is 'BusinessOperationState.failed', not
# 'failed', so `{str(s) for s in TERMINAL}` silently produces a set that matches nothing. Exporting
# the correct set removes the footgun instead of relying on each caller to remember `.value`.
TERMINAL_VALUES = frozenset(s.value for s in TERMINAL)

# States that mean "this will never move again without a new operation".
_RETRYABLE_STATES = {S.failed}

_PUBLIC_PHASES = {
    S.created.value: "pending",
    S.screening.value: "pending",
    S.compliance_pending.value: "pending",
    S.awaiting_deposit.value: "action_required",
    S.ready.value: "action_required",
    S.authorized.value: "action_required",
    S.proving.value: "processing",
    S.queued.value: "processing",
    S.submitted.value: "processing",
    S.ragequit_submitted.value: "processing",
    S.confirmed.value: "succeeded",
    S.ragequit_confirmed.value: "succeeded",
    S.failed.value: "failed",
    S.denied.value: "failed",
    S.revoked.value: "failed",
}


def public_phase(state: str) -> str:
    try:
        return _PUBLIC_PHASES[_s(state)]
    except KeyError:
        raise Conflict(f"Operation is in an unknown state ({state}).")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _s(value) -> str:
    """Normalize a state to its wire string.

    `BusinessOperationState` is a `(str, Enum)`, so `str(S.created)` is
    'BusinessOperationState.created', NOT 'created' — while `==` and `hash()` still behave like the
    plain string. That combination is a trap: dict lookups and comparisons pass while the value
    PERSISTED to the DB and emitted as a webhook event type is wrong. Always go through `.value`.
    """
    return value.value if isinstance(value, S) else str(value)


def create(
    db: Session,
    *,
    api_key_id: str,
    kind: str,
    subaccount_id: str | None = None,
    batch_id: str | None = None,
    chain_id: int | None = None,
    asset: str | None = None,
    amount_minor: int | None = None,
    recipient: str | None = None,
    wallet: str | None = None,
    state: str = S.created,
    detail: dict | None = None,
) -> Operation:
    op = Operation(
        api_key_id=api_key_id,
        subaccount_id=subaccount_id,
        batch_id=batch_id,
        kind=kind,
        state=_s(state),
        chain_id=chain_id,
        asset=asset,
        amount_minor=amount_minor,
        recipient=recipient,
        wallet=wallet,
        detail=detail,
    )
    db.add(op)
    db.flush()
    return op


def transition(
    db: Session,
    op: Operation,
    to_state: str,
    *,
    tx_hash: str | None = None,
    error_code: str | None = None,
    detail: dict | None = None,
    emit: bool = True,
) -> Operation:
    """Move an operation to `to_state`, validating the transition and emitting a webhook event.

    Idempotent on a no-op transition (same state) so a retried confirmation does not fail; any other
    illegal move raises Conflict rather than corrupting a record the integrator is polling.
    """
    current = _s(op.state)
    target = _s(to_state)

    if current == target:
        # Re-driving the same transition (e.g. a retried confirmation) is not an error.
        if tx_hash and not op.tx_hash:
            op.tx_hash = tx_hash
            db.flush()
        return op

    allowed = _TRANSITIONS.get(current)
    if allowed is None:
        raise Conflict(f"Operation is in an unknown state ({current}).")
    if target not in allowed:
        if current in TERMINAL:
            raise Conflict(
                f"Operation {op.id} is already in terminal state '{current}' and cannot move to '{target}'."
            )
        raise Conflict(f"Illegal operation transition: {current} -> {target}.")

    op.state = target
    op.updated_at = _now()
    if tx_hash:
        op.tx_hash = tx_hash
    if error_code:
        op.error_code = error_code
    if detail:
        merged = dict(op.detail or {})
        merged.update(detail)
        op.detail = merged
    op.retryable = 1 if target in _RETRYABLE_STATES else 0
    db.flush()

    if emit:
        # Imported here to keep the service layer import-cycle free.
        from app.services import webhook_service

        webhook_service.enqueue_operation_event(db, op)

    return op


def get_owned(db: Session, operation_id: str, api_key_id: str) -> Operation:
    """Fetch one operation, scoped to the caller. 404 (not 403) when it isn't theirs — a caller must
    not be able to confirm that another integrator's operation id exists."""
    op = db.query(Operation).filter_by(id=operation_id).first()
    if op is None or op.api_key_id != api_key_id:
        raise NotFound("Operation not found.")
    return op


def list_owned(
    db: Session,
    api_key_id: str,
    *,
    state: str | None = None,
    kind: str | None = None,
    subaccount_id: str | None = None,
    batch_id: str | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> tuple[list[Operation], str | None]:
    """Newest-first page of operations. Returns (rows, next_cursor).

    Cursor is the last seen operation id; we resolve its created_at and page strictly older than it,
    so a row inserted mid-pagination cannot shift the window and cause a skipped record.
    """
    q = db.query(Operation).filter(Operation.api_key_id == api_key_id)
    if state:
        q = q.filter(Operation.state == state)
    if kind:
        q = q.filter(Operation.kind == kind)
    if subaccount_id:
        q = q.filter(Operation.subaccount_id == subaccount_id)
    if batch_id:
        q = q.filter(Operation.batch_id == batch_id)

    if cursor:
        anchor = db.query(Operation).filter_by(id=cursor).first()
        if anchor is not None:
            q = q.filter(
                (Operation.created_at < anchor.created_at)
                | ((Operation.created_at == anchor.created_at) & (Operation.id < anchor.id))
            )

    limit = max(1, min(int(limit), 200))
    rows = q.order_by(Operation.created_at.desc(), Operation.id.desc()).limit(limit + 1).all()

    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = rows[-1].id
    return rows, next_cursor


def refresh_chain_state(db: Session, op: Operation) -> bool:
    """Reconcile one submitted operation from chain state.

    Returns True only when the operation transitions. RPC failures are deliberately treated as
    "not observed yet" so both request polling and the background monitor remain retryable.
    """
    if op.state != S.submitted.value or not op.tx_hash or not op.chain_id:
        return False
    from app.services import solana_devnet

    if solana_devnet.is_solana(op.chain_id):
        try:
            state = solana_devnet.signature_state(op.tx_hash)
        except Exception:
            return False
        if state == "failed":
            transition(db, op, S.failed, error_code="transaction_failed")
            return True
        if state == "confirmed":
            transition(db, op, S.confirmed)
            return True
        return False
    from app.services.confirmations import get_rpc_url, is_confirmed
    from web3 import Web3

    try:
        receipt = Web3(Web3.HTTPProvider(get_rpc_url(op.chain_id))).eth.get_transaction_receipt(
            op.tx_hash
        )
    except Exception:
        return False
    if receipt and receipt.get("status") == 0:
        transition(db, op, S.failed, error_code="transaction_failed")
        return True
    if receipt and is_confirmed(op.chain_id, op.tx_hash):
        transition(db, op, S.confirmed)
        return True
    return False


def public_view(op: Operation) -> dict:
    """Safe projection. Internal ids and cryptographic state never cross this boundary."""
    detail = op.detail or {}
    next_action = None
    if op.state in (S.awaiting_deposit.value, S.authorized.value):
        next_action = "submit_transaction"
    return {
        "operation_id": op.id,
        "kind": op.kind,
        "status": op.state,
        "phase": public_phase(op.state),
        "chain_id": op.chain_id,
        "asset": op.asset,
        "amount_minor": op.amount_minor,
        "recipient": op.recipient,
        "tx_hash": op.tx_hash,
        "batch_id": op.batch_id,
        "subaccount_id": op.subaccount_id,
        "account_id": detail.get("account_id") or detail.get("managed_account_id"),
        "next_action": next_action,
        "error_code": op.error_code,
        "retryable": bool(op.retryable),
        "admission": detail.get("admission"),
        "created_at": op.created_at,
        "updated_at": op.updated_at,
    }
