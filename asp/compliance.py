"""Compliance helpers — revoke intake on deny (pending cancel only)."""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from association_set import is_admitted
from db import META_METRIC_REVOKES, bump_meta_counter, write_audit
from pending_admit import cancel_pending, get_pending_by_commitment
from revocation_set import is_revoked, revoke_label
from util import normalize_depositor

log = logging.getLogger("aspv2.compliance")


def revoke_if_admitted(
    db: Session,
    *,
    label: str | int,
    reason: str,
    actor: str | None = None,
) -> dict | None:
    """Postman/ops path: if label is in ASP and not yet revoked, SMT-revoke it."""
    lab = str(label).strip()
    if not lab or lab == "0":
        return None
    if not is_admitted(db, lab):
        return None
    if is_revoked(db, lab):
        return {"skipped": True, "reason": "already_revoked", "label": lab}
    out = revoke_label(db, label=lab, reason=reason)
    bump_meta_counter(db, META_METRIC_REVOKES)
    write_audit(db, action="compliance_revoke", payload={"label": lab, "reason": reason}, actor=actor)
    return out


def handle_screen_deny(
    db: Session,
    *,
    chain_id: int,
    commitment: str | None,
    depositor: str | None = None,
    label: str | None = None,
    reasons: list[str] | None = None,
) -> dict:
    """On deny: cancel pending admit outbox only when deny depositor owns the pending row.

    Never revoke from client-supplied `label` on the screen path.
    F-2: cross-depositor deny must not cancel another party's pending.
    """
    _ = label  # ignored — do not revoke from screen
    reasons = reasons or []
    result: dict = {"cancelledPending": False, "revoked": None, "skipped": None}
    if not commitment:
        return result
    pending = get_pending_by_commitment(db, chain_id, commitment)
    if not pending or pending.status != "pending":
        return result
    deny_dep = normalize_depositor(depositor, chain_id)
    pend_dep = normalize_depositor(pending.depositor, chain_id)
    if not deny_dep or not pend_dep or deny_dep != pend_dep:
        result["skipped"] = "depositor_mismatch"
        return result
    cancel_pending(db, pending, f"screen_deny:{','.join(reasons[:3])}")
    result["cancelledPending"] = True
    return result
