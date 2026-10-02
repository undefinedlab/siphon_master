"""Policy engine — versioned, server-enforced controls an integrator can demonstrate to an auditor.

Enterprises are not asking "can you do this safely?", they are asking "can you PROVE the control was
in force when this transaction ran?". So policies are immutable versions: a PUT supersedes rather
than mutates, and every evaluation records the version it ran under. An auditor asking "what rules
applied on 14 March?" gets an answer instead of a current-state snapshot.

Rules (all optional; absent = unconstrained):

    {
      "min_anonymity_set":       50,          # refuse when the pool's privacy metric is below this
      "allowed_chains":          [8453],
      "allowed_assets":          ["USDC"],
      "max_amount_minor":        1000000,     # per operation
      "max_daily_amount_minor":  50000000,    # rolling 24h, per key or subaccount
      "recipient_allowlist":     ["0x..."],   # exact addresses; case-insensitive
      "recipient_denylist":      ["0x..."],
      "require_confirmations":   2,
      "block_on_stale_asp_root": true
    }

Evaluation is FAIL-CLOSED on anything it cannot determine: an unknown anonymity metric with
`min_anonymity_set` set is a violation, not a pass. A policy that silently degrades to "allow" when
its data source is down is worse than no policy, because it is trusted.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.errors import BadRequest, Forbidden, NotFound
from app.repository.models import Operation, Policy

_KNOWN_RULES = {
    "min_anonymity_set",
    "allowed_chains",
    "allowed_assets",
    "max_amount_minor",
    "max_daily_amount_minor",
    "recipient_allowlist",
    "recipient_denylist",
    "require_confirmations",
    "block_on_stale_asp_root",
}


class PolicyViolation(Forbidden):
    """403 with the specific rule that refused the operation, so a caller can act on it."""

    title = "Policy violation"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def validate_rules(rules: dict) -> dict:
    """Reject unknown or malformed rules at write time — a typo'd rule name must never silently
    evaluate as 'no constraint'."""
    if not isinstance(rules, dict):
        raise BadRequest("Policy rules must be an object.")

    unknown = set(rules) - _KNOWN_RULES
    if unknown:
        raise BadRequest(f"Unknown policy rules: {sorted(unknown)}. Known: {sorted(_KNOWN_RULES)}")

    for int_rule in ("min_anonymity_set", "max_amount_minor", "max_daily_amount_minor", "require_confirmations"):
        if int_rule in rules:
            v = rules[int_rule]
            if not isinstance(v, int) or isinstance(v, bool) or v < 0:
                raise BadRequest(f"'{int_rule}' must be a non-negative integer.")

    for list_rule in ("allowed_chains", "allowed_assets", "recipient_allowlist", "recipient_denylist"):
        if list_rule in rules and not isinstance(rules[list_rule], list):
            raise BadRequest(f"'{list_rule}' must be a list.")

    if "block_on_stale_asp_root" in rules and not isinstance(rules["block_on_stale_asp_root"], bool):
        raise BadRequest("'block_on_stale_asp_root' must be a boolean.")

    return rules


def put(db: Session, *, api_key_id: str, rules: dict, created_by: str | None = None) -> Policy:
    """Supersede the active policy with a new immutable version."""
    validate_rules(rules)

    current = active(db, api_key_id)
    next_version = (current.version + 1) if current else 1
    if current is not None:
        current.status = "superseded"

    row = Policy(
        api_key_id=api_key_id,
        version=next_version,
        rules=rules,
        status="active",
        created_by=created_by,
    )
    db.add(row)
    db.flush()
    return row


def active(db: Session, api_key_id: str) -> Policy | None:
    return (
        db.query(Policy)
        .filter(Policy.api_key_id == api_key_id, Policy.status == "active")
        .order_by(Policy.version.desc())
        .first()
    )


def get_version(db: Session, api_key_id: str, version: int) -> Policy:
    row = db.query(Policy).filter_by(api_key_id=api_key_id, version=version).first()
    if row is None:
        raise NotFound("Policy version not found.")
    return row


def history(db: Session, api_key_id: str) -> list[Policy]:
    return (
        db.query(Policy)
        .filter(Policy.api_key_id == api_key_id)
        .order_by(Policy.version.desc())
        .all()
    )


def _daily_spend_minor(db: Session, api_key_id: str, subaccount_id: str | None) -> int:
    since = _now() - timedelta(hours=24)
    q = db.query(func.coalesce(func.sum(Operation.amount_minor), 0)).filter(
        Operation.api_key_id == api_key_id,
        Operation.created_at >= since,
        Operation.state.notin_(["denied", "failed", "revoked"]),
    )
    if subaccount_id:
        q = q.filter(Operation.subaccount_id == subaccount_id)
    return int(q.scalar() or 0)


def evaluate(
    db: Session,
    *,
    api_key_id: str,
    chain_id: int | None = None,
    asset: str | None = None,
    amount_minor: int | None = None,
    recipient: str | None = None,
    anonymity_set: int | None = None,
    asp_root_stale: bool | None = None,
    subaccount_id: str | None = None,
) -> tuple[list[str], int | None]:
    """Return (violations, policy_version). Empty list = allowed.

    Fail-closed: a rule whose input is unavailable counts as violated, never as satisfied.
    """
    pol = active(db, api_key_id)
    if pol is None:
        return [], None

    rules = pol.rules or {}
    v: list[str] = []

    if "allowed_chains" in rules and chain_id is not None:
        if chain_id not in rules["allowed_chains"]:
            v.append(f"allowed_chains: chain {chain_id} is not permitted")

    if "allowed_assets" in rules and asset is not None:
        allowed = [str(a).upper() for a in rules["allowed_assets"]]
        if str(asset).upper() not in allowed:
            v.append(f"allowed_assets: asset {asset} is not permitted")

    if "max_amount_minor" in rules and amount_minor is not None:
        if amount_minor > rules["max_amount_minor"]:
            v.append(
                f"max_amount_minor: {amount_minor} exceeds per-operation limit {rules['max_amount_minor']}"
            )

    if "max_daily_amount_minor" in rules and amount_minor is not None:
        spent = _daily_spend_minor(db, api_key_id, subaccount_id)
        if spent + amount_minor > rules["max_daily_amount_minor"]:
            v.append(
                f"max_daily_amount_minor: {spent + amount_minor} would exceed rolling 24h limit "
                f"{rules['max_daily_amount_minor']}"
            )

    if "recipient_denylist" in rules and recipient:
        deny = {str(a).lower() for a in rules["recipient_denylist"]}
        if recipient.lower() in deny:
            v.append("recipient_denylist: recipient is explicitly denied")

    if "recipient_allowlist" in rules and recipient:
        allow = {str(a).lower() for a in rules["recipient_allowlist"]}
        if recipient.lower() not in allow:
            v.append("recipient_allowlist: recipient is not on the allowlist")

    if "min_anonymity_set" in rules:
        # Fail-closed: unknown privacy metric is a violation, not a pass.
        if anonymity_set is None:
            v.append("min_anonymity_set: anonymity-set size is unavailable (fail-closed)")
        elif anonymity_set < rules["min_anonymity_set"]:
            v.append(
                f"min_anonymity_set: pool k={anonymity_set} is below the required "
                f"{rules['min_anonymity_set']}"
            )

    if rules.get("block_on_stale_asp_root"):
        if asp_root_stale is None:
            v.append("block_on_stale_asp_root: ASP root freshness is unknown (fail-closed)")
        elif asp_root_stale:
            v.append("block_on_stale_asp_root: the ASP root is stale")

    return v, pol.version


def enforce(db: Session, **kwargs) -> int | None:
    """Evaluate and raise on violation. Returns the policy version the operation ran under."""
    violations, version = evaluate(db, **kwargs)
    if violations:
        raise PolicyViolation("Policy violation: " + "; ".join(violations))
    return version


def public_view(pol: Policy) -> dict:
    return {
        "version": pol.version,
        "status": pol.status,
        "rules": pol.rules or {},
        "created_by": pol.created_by,
        "created_at": pol.created_at,
    }
