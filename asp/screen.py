"""KYT screening pipeline — cheap layer1 (lists + oracle) then zkMe if entitled."""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

import config
from db import (
    META_METRIC_ZKME_CALLS,
    META_METRIC_ZKME_DENIES,
    META_METRIC_ZKME_UNAVAILABLE,
    ScreenResult,
    bump_meta_counter,
    find_list_hits,
    has_active_kyt_entitlement,
    list_counts,
    new_decision_id,
)
from oracle import OracleUnavailable, is_sanctioned
from util import normalize_depositor
from zkme import ZkMeUnavailable, is_configured as zkme_configured, screen_address as zkme_screen


@dataclass
class ScreenOutcome:
    decision: str  # admit | deny | pending
    set_id: str = config.SET_ID
    reasons: list[str] = field(default_factory=list)
    checked: list[dict] = field(default_factory=list)
    deps: dict = field(default_factory=dict)
    policy_version: str = config.POLICY_VERSION
    decision_id: str | None = None
    commitment: str | None = None
    precommitment: str | None = None

    def to_dict(self) -> dict:
        return {
            "decision": self.decision,
            "decisionId": self.decision_id,
            "setId": self.set_id,
            "reasons": self.reasons,
            "checked": self.checked,
            "deps": self.deps,
            "policyVersion": self.policy_version,
            "protocolVersion": config.PROTOCOL_VERSION,
            "commitment": self.commitment,
        }


def _degraded(_reason: str) -> str:
    return "deny" if config.DEGRADED_AS_DENY else "pending"


def screen(
    db: Session,
    *,
    chain_id: int,
    depositor: str,
    tx_hash: str | None = None,
    commitment: str | None = None,
    precommitment: str | None = None,
    persist: bool = True,
    request_obj: dict | None = None,
) -> ScreenOutcome:
    dep = normalize_depositor(depositor, chain_id)
    commitment = (commitment or "").strip() or None
    precommitment = (precommitment or "").strip() or None

    if not dep:
        out = ScreenOutcome(decision="deny", reasons=["invalid_depositor"])
        _persist(db, out, request_obj or {}, persist, chain_id, None, tx_hash, commitment, precommitment)
        return out

    counts = list_counts(db)
    lists_ok = (counts.get("sanction", 0) + counts.get("mixer", 0)) > 0
    entitled = has_active_kyt_entitlement(db, dep)
    deps: dict = {
        "listsOk": lists_ok,
        "listCounts": counts,
        "zkme": "unconfigured" if not zkme_configured() else "ok",
        "kytEntitlement": entitled,
        "oracleFailClosed": config.ORACLE_FAIL_CLOSED,
    }

    if config.REQUIRE_SEEDED_LISTS and not lists_ok:
        out = ScreenOutcome(
            decision=_degraded("lists_unseeded"),
            reasons=["lists_unseeded"],
            deps=deps,
            commitment=commitment,
            precommitment=precommitment,
        )
        _persist(db, out, request_obj or {}, persist, chain_id, dep, tx_hash, commitment, precommitment)
        return out

    # ---- Layer 1 (cheap): local lists + sanctions oracle — never call zkMe on hit ----
    hits = find_list_hits(db, [dep])
    reasons: list[str] = []
    entry: dict = {"address": dep, "role": "depositor", "hits": []}

    for h in hits:
        if h.kind == "cex_allowlist":
            entry["hits"].append({"kind": h.kind, "source": h.source, "entity": h.entity_name})
            continue
        if h.kind == "mixer":
            reasons.append("mixer")
        elif h.kind == "sanction":
            reasons.append("ofac_list")
        elif h.kind == "custom_ban":
            reasons.append("custom_ban")
        entry["hits"].append({"kind": h.kind, "source": h.source, "entity": h.entity_name})

    try:
        if is_sanctioned(dep, chain_id):
            reasons.append("ofac_oracle")
            entry["hits"].append({"kind": "oracle", "source": "chainalysis_oracle"})
    except OracleUnavailable:
        reasons.append("oracle_unavailable")
        entry["hits"].append({"kind": "oracle", "source": "unavailable"})

    checked = [entry]

    if reasons:
        out = ScreenOutcome(
            decision="deny",
            reasons=_dedup(reasons),
            checked=checked,
            deps=deps,
            commitment=commitment,
            precommitment=precommitment,
        )
        _persist(db, out, request_obj or {}, persist, chain_id, dep, tx_hash, commitment, precommitment)
        return out

    # ---- Layer 2: zkMe KYT — only if configured + entitled (or skip-fee escape) ----
    if zkme_configured():
        if not entitled and not config.ALLOW_SKIP_KYT_FEE:
            deps["zkme"] = "fee_required"
            out = ScreenOutcome(
                decision="pending",
                reasons=["kyt_fee_required"],
                checked=checked,
                deps=deps,
                commitment=commitment,
                precommitment=precommitment,
            )
            _persist(db, out, request_obj or {}, persist, chain_id, dep, tx_hash, commitment, precommitment)
            return out
        try:
            zkme_result = zkme_screen(dep, chain_id)
            deps["zkme"] = "ok"
            if persist:
                bump_meta_counter(db, META_METRIC_ZKME_CALLS)
            entry["hits"].append(
                {
                    "kind": "zkme_kyt",
                    "riskScore": zkme_result.risk_score,
                    "riskLevel": zkme_result.risk_level,
                    "decision": zkme_result.decision,
                }
            )
            if zkme_result.decision == "deny":
                if persist:
                    bump_meta_counter(db, META_METRIC_ZKME_DENIES)
                reasons.extend(zkme_result.reasons or ["zkme_high_risk"])
        except ZkMeUnavailable as exc:
            deps["zkme"] = "unavailable"
            if persist:
                bump_meta_counter(db, META_METRIC_ZKME_UNAVAILABLE)
            reasons.append("zkme_unavailable")
            entry["hits"].append({"kind": "zkme_kyt", "source": "unavailable", "error": str(exc)})
    else:
        deps["zkme"] = "unconfigured"

    decision = "deny" if reasons else "admit"
    if reasons == ["zkme_unavailable"]:
        decision = _degraded("zkme_unavailable")

    out = ScreenOutcome(
        decision=decision,
        reasons=_dedup(reasons),
        checked=checked,
        deps=deps,
        commitment=commitment,
        precommitment=precommitment,
    )
    _persist(db, out, request_obj or {}, persist, chain_id, dep, tx_hash, commitment, precommitment)
    return out


def _dedup(reasons: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for r in reasons:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


def _persist(
    db: Session,
    out: ScreenOutcome,
    request_obj: dict,
    persist: bool,
    chain_id: int | None,
    depositor: str | None,
    tx_hash: str | None,
    commitment: str | None,
    precommitment: str | None,
) -> None:
    if not persist:
        return
    did = new_decision_id()
    out.decision_id = did
    safe_req = {
        k: v
        for k, v in (request_obj or {}).items()
        if k.lower()
        not in (
            "label",
            "precommitment",
            "secret",
            "nullifier",
            "usersalt",
            "user_salt",
            "salt",
        )
    }
    db.add(
        ScreenResult(
            decision_id=did,
            chain_id=chain_id,
            depositor=depositor,
            tx_hash=(tx_hash or "").lower() or None,
            commitment=commitment,
            precommitment=None,
            request_json=json.dumps(safe_req, sort_keys=True),
            decision=out.decision,
            reasons=json.dumps(out.reasons),
            addresses_checked=json.dumps(out.checked),
            deps_json=json.dumps(out.deps),
            policy_version=out.policy_version,
        )
    )
    db.commit()
