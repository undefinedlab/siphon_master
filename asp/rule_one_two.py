"""Rule 1/2 revocation selection — after-merge compliance freeze.

we intend to block laundering of value revoked (case when revoked late), so if a
label matches exact value of the revoked label we revoke it simply, if not then
the smallest label > x will be revoked, to ensure compliance.

(Implemented with the source label checked first: when the flagged label is
still live it is revoked directly, irrespective of value, before the exact and
smallest-fit rules below.)

WHY THIS EXISTS
---------------
Per-input SMT non-inclusion (PROTOCOL §2.5) only blocks a note whose label was
revoked *before* it was spent. If a bad deposit is MERGEd before the ASP flags
it, the deposit note is already spent (nullifier burned) and its value now lives
inside a merged note under a *different* label (greedy-largest inheritance).
There is no on-chain lineage to follow: public[8] (outLabel) is 0, the merged
amount is hidden, and the indexer stores no labels. So the bad value cannot be
identified by tracing.

The fix is justified by FUNGIBILITY, not lineage. Compliance requires freezing
X of the depositor's value — not the specific coins. SPLIT/MERGE both require
an admitted, non-revoked label, so value kept in-pool always sits under a live
admitted label whose amount is known from its deposit. Therefore:

    live in-pool value >= X  <=>  freezable >= X from live admitted labels

and "no live label covers X" implies the value already left the pool, where
freezing it is moot.

SELECTION ORDER
---------------
source — if the flagged label is itself still live, revoke it and stop,
         irrespective of its value; accept that some funds may already have
         gone through. It is the actual bad label and revoking it blocks every
         child note that inherited it, so it is always the tightest correct
         freeze. Checked first: substituting a fungible label while the real
         bad label stays spendable would be strictly worse.
Rule 1  exact — a live label whose deposit amount == X. Freeze it.
Rule 2  smallest-fit — the smallest single live label with amount >= X.
otherwise — freeze nothing, report sufficient=False plus the candidate set.

Deliberately single-label: there is no greedy multi-label sweep. Freezing one
label of at least X satisfies the obligation, and sweeping several would
over-freeze clean value.

D1 / PER-ASSET
--------------
Notes are asset-bound (commitment binds assetId = uint160(token)), so every
query here is scoped by asset_id. A flagged USDC deposit never freezes ETH.

DEFERRED — spent-status refinement
----------------------------------
Selection considers a label live when it is in the ASP and not in the revocation
SMT. It cannot yet tell whether that label's note was already spent, because
the indexer's /state/leaves is HTTP 503 until NoteTree.insert emits an event
(see siphon-indexer-v2/docs/PHASE-B-STATE-LEAVES.md). Worst case a just-spent
label is chosen and the freeze is a harmless no-op. Wire indexer spent-status
in once that blocker clears.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from db import AspLabel, RevokedLabel

log = logging.getLogger("aspv2.rule_one_two")

POLICY_EXACT = "rule_1_exact"
POLICY_SMALLEST_FIT = "rule_2_smallest_fit"
POLICY_SOURCE_LABEL = "source_label"
POLICY_NONE = "none"


def canonical_amount(amount: str | int) -> int:
    """Parse a minor-unit amount; must be a non-negative integer."""
    raw = str(amount).strip()
    if not raw:
        raise ValueError("amount required")
    try:
        value = int(raw, 16) if raw.lower().startswith("0x") else int(raw, 10)
    except ValueError as exc:
        raise ValueError("amount must be a decimal or 0x hex integer") from exc
    if value < 0:
        raise ValueError("amount must be non-negative")
    return value


def canonical_asset_id(asset_id: str | int) -> str:
    """Normalize assetId to a decimal string. Accepts a 0x token address."""
    raw = str(asset_id).strip().lower()
    if not raw:
        raise ValueError("assetId required")
    try:
        value = int(raw, 16) if raw.startswith("0x") else int(raw, 10)
    except ValueError as exc:
        raise ValueError("assetId must be a token address or decimal uint160") from exc
    if value < 0 or value >= (1 << 160):
        raise ValueError("assetId must fit in uint160")
    return str(value)


@dataclass
class Candidate:
    """A live admitted label eligible to be frozen."""

    label: str
    amount: int
    leaf_index: int

    def as_dict(self) -> dict:
        return {"label": self.label, "amount": str(self.amount), "leafIndex": self.leaf_index}


@dataclass
class Selection:
    labels: list[str] = field(default_factory=list)
    covered: int = 0
    requested: int = 0
    policy: str = POLICY_NONE
    sufficient: bool = False
    candidates: list[Candidate] = field(default_factory=list)

    @property
    def shortfall(self) -> int:
        return max(0, self.requested - self.covered)

    def as_dict(self) -> dict:
        return {
            "labels": list(self.labels),
            "covered": str(self.covered),
            "requested": str(self.requested),
            "shortfall": str(self.shortfall),
            "policy": self.policy,
            "sufficient": self.sufficient,
            "candidates": [c.as_dict() for c in self.candidates],
        }


def live_labels(
    db: Session,
    *,
    depositor: str,
    asset_id: str,
) -> list[Candidate]:
    """Depositor's admitted, non-revoked, known-amount labels for one asset.

    Live == present in the ASP tree AND absent from the revocation SMT. Rows
    with a NULL amount predate the Rule 1/2 columns; their value is unknown so
    they are not safely freezable and are excluded.

    'queued' labels are included: they are already in the admitted tree and the
    revoke publishes atomically alongside, so excluding them would leave a
    5-minute admit-epoch window in which fresh deposits cannot be frozen.
    """
    dep = (depositor or "").strip().lower()
    if not dep:
        raise ValueError("depositor required")

    revoked = select(RevokedLabel.label).where(RevokedLabel.label == AspLabel.label)
    rows = (
        db.execute(
            select(AspLabel)
            .where(
                AspLabel.depositor == dep,
                AspLabel.asset_id == asset_id,
                AspLabel.amount.is_not(None),
                ~revoked.exists(),
            )
            .order_by(AspLabel.leaf_index.asc())
        )
        .scalars()
        .all()
    )

    out: list[Candidate] = []
    for row in rows:
        try:
            value = canonical_amount(row.amount)
        except ValueError:
            log.warning("skipping label %s — unparsable amount", row.label)
            continue
        out.append(Candidate(label=row.label, amount=value, leaf_index=row.leaf_index))
    return out


def _source_label_candidate(
    db: Session,
    *,
    flagged_label: str,
    depositor: str,
    asset_id: str,
) -> Candidate | None:
    """The flagged label itself, when still live (the source rule).

    Scoped to the same depositor + asset as the rest of selection so a caller
    cannot freeze an unrelated party's label by passing a mismatched pair.
    """
    dep = (depositor or "").strip().lower()
    revoked = select(RevokedLabel.label).where(RevokedLabel.label == AspLabel.label)
    row = db.execute(
        select(AspLabel).where(
            AspLabel.label == flagged_label,
            AspLabel.depositor == dep,
            AspLabel.asset_id == asset_id,
            ~revoked.exists(),
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    try:
        value = canonical_amount(row.amount) if row.amount is not None else 0
    except ValueError:
        value = 0
    return Candidate(label=row.label, amount=value, leaf_index=row.leaf_index)


def select_labels_to_freeze(
    db: Session,
    *,
    depositor: str,
    amount_x: str | int,
    asset_id: str | int,
    flagged_label: str | None = None,
) -> Selection:
    """Pick the label(s) to revoke to freeze `amount_x` of the depositor's value.

    Source (the flagged label, when still live) -> Rule 1 (exact) -> Rule 2
    (smallest fit >= X) -> nothing. Returns the decision; the caller does the
    revoking so all SMT inserts land in one transaction with one publish.
    """
    target = canonical_amount(amount_x)
    asset = canonical_asset_id(asset_id)
    candidates = live_labels(db, depositor=depositor, asset_id=asset)

    sel = Selection(requested=target, candidates=candidates)

    # Source first — if the flagged label is still live, revoke it and stop,
    # irrespective of its value. It is the actual bad label, and revoking it
    # blocks every child note that inherited it. Some value may already have
    # escaped through earlier merges; that is accepted, because freezing the
    # source is still the tightest correct action available. Substituting a
    # fungible label here would leave the real bad label spendable.
    if flagged_label:
        source = _source_label_candidate(
            db, flagged_label=flagged_label, depositor=depositor, asset_id=asset
        )
        if source is not None:
            sel.labels = [source.label]
            sel.covered = source.amount
            sel.policy = POLICY_SOURCE_LABEL
            sel.sufficient = True
            return sel

    # Rule 1 — exact fit. Lowest leaf_index wins so the choice is deterministic.
    for cand in candidates:
        if cand.amount == target:
            sel.labels = [cand.label]
            sel.covered = cand.amount
            sel.policy = POLICY_EXACT
            sel.sufficient = True
            return sel

    # Rule 2 — smallest single label >= X. Tightest fit over-freezes the least.
    fitting = [c for c in candidates if c.amount >= target]
    if fitting:
        best = min(fitting, key=lambda c: (c.amount, c.leaf_index))
        sel.labels = [best.label]
        sel.covered = best.amount
        sel.policy = POLICY_SMALLEST_FIT
        sel.sufficient = True
        return sel

    # Nothing fits — the value has left the pool. Report, never fabricate.
    sel.policy = POLICY_NONE
    sel.sufficient = False
    return sel
