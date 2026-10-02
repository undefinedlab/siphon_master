"""Settle v5 operations from chain state, run by the operation monitor.

Two things the request path cannot finish on its own:

- **Relays whose reply was lost (G-4).** `/relaySpend` has no durable journal, so a timeout leaves
  the payout `authorized` with no hash. The first input nullifier is the ground truth: once
  NullifierSet marks it used the spend landed (whoever broadcast it); if it is still unused well
  after the relayer's own retry window, nothing will land and the proof can be resubmitted.
- **Deposit admission (G-1).** Screening ran on a PREDICTED commitment — it depends on the kernel's
  deposit counter at mining time, so any deposit mined first changes it. Once ours confirms, admit
  it from the mined Deposited event (re-screening on the real commitment when the prediction was
  stale). The ASP derives the label itself from userSalt + depositNonce.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from app.errors import GatewayError
from app.repository.models import IdempotencyKey, Operation
from app.schemas.compliance import BusinessOperationState as S
from app.services import operation_service
from app.services import unsigned_transaction_service as uts
from app.services.v5_chains import asp, chain

logger = logging.getLogger("siphon.gateway.v5_reconcile")

RELAY_GRACE = timedelta(minutes=2)  # the executor's send path retries for about this long
RELAY_GIVE_UP = timedelta(minutes=30)
ADMIT_GIVE_UP = timedelta(hours=24)  # the ASP's own admit window


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(t: datetime | None) -> datetime | None:
    return t.replace(tzinfo=timezone.utc) if t is not None and t.tzinfo is None else t


def complete_failed_reservation(db, relay_id: str | None, error_code: str) -> None:
    """Finish the payout's idempotency row as failed, so a retry gets an answer, not a 409 forever."""
    row = db.get(IdempotencyKey, relay_id) if relay_id else None
    if row is not None and row.status == "in_progress":
        row.status = "completed"
        row.status_code = 409
        row.response_body = {"error_code": error_code}


def _complete_confirmed_reservation(db, op: Operation) -> None:
    from app.schemas.business import PayoutResponse, SplitResponse
    from app.schemas.platform import OperationView

    row = db.get(IdempotencyKey, (op.detail or {}).get("relay_id") or "")
    if row is not None and row.status == "in_progress":
        view = OperationView(**operation_service.public_view(op))
        row.status = "completed"
        row.status_code = 200
        row.response_body = (
            SplitResponse(operation=view, tx_hash=None) if op.kind == "split"
            else PayoutResponse(operation=view, submission_mode="relay", transaction=None, tx_hash=None)
        ).model_dump(mode="json")


def settle_relay(db, op: Operation) -> bool:
    """An authorized v5 relay payout with no hash: decide it from the nullifier."""
    detail = op.detail or {}
    started = detail.get("relay_started_at")
    started_at = datetime.fromisoformat(started) if started else _aware(op.created_at)
    age = _now() - _aware(started_at)
    if age < RELAY_GRACE or not detail.get("nullifier"):
        return False
    try:
        from app.services import solana_devnet

        landed = (solana_devnet.nullifier_spent(int(detail["nullifier"])) if solana_devnet.is_solana(op.chain_id)
                  else uts.nullifier_used(op.chain_id, int(detail["nullifier"])))
    except Exception:  # noqa: BLE001 — RPC trouble is "not known yet", never a verdict
        return False
    if landed:
        operation_service.transition(db, op, S.submitted)
        operation_service.transition(db, op, S.confirmed)
        # The spend is final on-chain; only its hash was lost with the relayer's reply.
        op.detail = {**detail, "tx_hash_unknown": True}
        _complete_confirmed_reservation(db, op)
        return True
    if age > RELAY_GIVE_UP:
        operation_service.transition(db, op, S.failed, error_code="relay_unconfirmed")
        complete_failed_reservation(db, detail.get("relay_id"), "relay_unconfirmed")
        return True
    return False


def admit_deposit(db, op: Operation) -> bool:
    """Admit a confirmed v5 deposit at the chain's ASP. Returns True when `admission` changed."""
    detail = dict(op.detail or {})
    if _now() - _aware(op.updated_at or op.created_at) > ADMIT_GIVE_UP:
        op.detail = {**detail, "admission": "expired"}
        return True
    try:
        dep = uts.parse_deposited(op.chain_id, op.tx_hash)
    except Exception:  # noqa: BLE001 — RPC trouble: try again next tick
        return False
    c = chain(op.chain_id)
    if dep is None or (dep.get("from") or "").lower() != (op.wallet or "").lower() or not dep.get("user_salt"):
        # Not a kernel deposit from this account's wallet: never admit someone else's label.
        op.detail = {**detail, "admission": "rejected"}
        return True
    body = {
        "chainId": op.chain_id,
        "txHash": op.tx_hash,
        "vault": c.vault_kernel,
        "depositor": op.wallet.lower(),
        "userSalt": dep["user_salt"],
        "commitment": dep["commitment"],
    }
    client = asp(op.chain_id)
    try:
        if dep["commitment"] != detail.get("commitment"):
            # The prediction went stale (another deposit was mined first): screen the real one.
            screened = client.screen({"chainId": op.chain_id, "depositor": op.wallet.lower(), "txHash": op.tx_hash,
                                      "commitment": dep["commitment"], "userSalt": dep["user_salt"], "asset": dep["token"]})
            if str(screened.get("decision", "")).lower() != "admit":
                return False  # pending/deny: the ASP decides; a deny lands in its revocation flow
        client.admit(body)
    except GatewayError as exc:
        text = str(exc.detail).lower()
        if "already" in text:
            pass  # the ASP's own watcher got there first
        elif exc.status >= 500 or "confirm" in text:
            return False  # transient, or not deep enough yet
        else:
            logger.warning("v5 admission refused for op %s: %s", op.id, exc.detail)
            op.detail = {**detail, "admission": "refused", "admission_error": str(exc.detail)[:200]}
            return True
    op.detail = {**detail, "admission": "admitted", "commitment": dep["commitment"]}
    return True
