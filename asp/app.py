"""siphon-aspv2 HTTP API — screening layer (zkv2 / ComplianceHub aligned)."""
from __future__ import annotations

import hmac
import logging
import os
import re
import time
from collections import defaultdict
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, jsonify, request

import config
from association_set import (
    _load_labels_ordered,
    admit_label,
    get_admitted_path,
    is_admitted,
)
from chain_verify import read_onchain_roots, verify_deposited, verify_screen_admit_binding
from db import (
    META_DRIFT_ADMITTED,
    META_DRIFT_REVOKED,
    META_LAST_ADMIT_PUBLISH_TS,
    META_METRIC_ADMITS,
    META_METRIC_REVOKES,
    META_METRIC_SCREENS,
    META_METRIC_WATCHER_ADMITS,
    META_METRIC_ZKME_CALLS,
    META_METRIC_ZKME_DENIES,
    META_METRIC_ZKME_UNAVAILABLE,
    META_PENDING_ADMIT_PUBLISH,
    bump_meta_counter,
    deactivate_address,
    get_decision_by_commitment,
    get_decision_by_tx,
    get_meta,
    init_db,
    list_counts,
    session,
    set_meta,
    upsert_address,
    write_audit,
)
from compliance import handle_screen_deny
from core.label import derive_deposit_label
from revocation_set import (
    _load_revoked_labels,
    canonical_label,
    current_revoked_root,
    dual_root_snapshot,
    get_smt_inclusion_path,
    get_smt_non_inclusion_path,
    is_revoked,
    revoke_label,
)
from screen import screen
from snapshot_sig import sign_snapshot
from util import normalize_address, normalize_depositor
from zkme import is_configured as zkme_configured

logging.basicConfig(level=logging.INFO, format="[aspv2] %(levelname)s %(message)s")
log = logging.getLogger("aspv2")

app = Flask(__name__)
init_db()

_TX_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
_COMMITMENT_RE = re.compile(r"^\d{1,78}$|^0x[0-9a-fA-F]{1,64}$")
_rate_buckets: dict[str, list[float]] = defaultdict(list)


def _maybe_seed_lists() -> None:
    try:
        with session() as db:
            counts = list_counts(db)
        if (counts.get("sanction", 0) + counts.get("mixer", 0)) == 0:
            log.info("Lists unseeded — loading mixer + sanction seeds…")
            from lists.seed_mixers import seed_mixers
            from lists.seed_sanctions import seed_sanctions

            seed_mixers()
            seed_sanctions()
            with session() as db:
                log.info("Seed complete: %s", list_counts(db))
    except Exception as exc:
        log.warning("List auto-seed failed: %s", exc)


_maybe_seed_lists()


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    return _text(value).lower() in ("1", "true", "yes")


def _asset_id_from_token(token) -> str | None:
    """D1 asset binding: assetId = uint160(token), stored as a decimal string."""
    raw = _text(token).lower()
    if not raw:
        return None
    try:
        return str(int(raw, 16) if raw.startswith("0x") else int(raw, 10))
    except ValueError:
        return None


def _client_ip() -> str:
    return request.remote_addr or "unknown"


def _rate_limit_ok(key: str, cost: int = 1) -> bool:
    """Redis-backed when ASP_REDIS_URL set; else in-process (dev / single worker).

    `cost` charges N units (batch screens pass len(items)).
    F-4: check budget before charging so rejects do not consume quota.
    """
    window = config.SCREEN_RATE_WINDOW_SEC
    limit = config.SCREEN_RATE_LIMIT
    cost = max(1, int(cost))
    if config.REDIS_URL:
        try:
            import redis

            r = getattr(_rate_limit_ok, "_redis", None)
            if r is None:
                r = redis.Redis.from_url(config.REDIS_URL, decode_responses=True)
                _rate_limit_ok._redis = r  # type: ignore[attr-defined]
            rk = f"aspv2:rl:{key}"
            # Atomic: only charge if current + cost <= limit
            lua = """
            local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
            local cost = tonumber(ARGV[1])
            local lim = tonumber(ARGV[2])
            local ttl = tonumber(ARGV[3])
            if cur + cost > lim then
              return -1
            end
            local n = redis.call('INCRBY', KEYS[1], cost)
            if n == cost then
              redis.call('EXPIRE', KEYS[1], ttl)
            end
            return n
            """
            n = int(r.eval(lua, 1, rk, cost, limit, window))
            return n >= 0
        except Exception as exc:
            log.warning("redis rate limit failed — fail closed: %s", exc)
            return False
    # production always has REDIS_URL (config gate); in-proc only for single-worker dev
    if config.PRODUCTION_LOCK:
        log.warning("rate limit refused — ASP_REDIS_URL unset under PRODUCTION_LOCK")
        return False
    now = time.time()
    bucket = _rate_buckets[key]
    _rate_buckets[key] = [t for t in bucket if now - t < window]
    if len(_rate_buckets[key]) + cost > limit:
        return False
    _rate_buckets[key].extend([now] * cost)
    return True


def _check_token(expected: str, header_names: tuple[str, ...] = ("Authorization", "X-Asp-Token")) -> bool:
    # F-6: empty configured token never authenticates
    if not expected:
        return False
    for h in header_names:
        raw = request.headers.get(h) or ""
        if raw.lower().startswith("bearer "):
            raw = raw[7:].strip()
        if raw and hmac.compare_digest(raw, expected):
            return True
    return False


def require_screen_token(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not config.SCREEN_TOKEN:
            return jsonify({"error": "ASP_SCREEN_TOKEN required"}), 503
        if not _check_token(config.SCREEN_TOKEN):
            return jsonify({"error": "unauthorized"}), 401
        return fn(*args, **kwargs)

    return wrapper


def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not config.ADMIN_TOKEN:
            return jsonify({"error": "ASP_ADMIN_TOKEN not configured"}), 503
        if not _check_token(config.ADMIN_TOKEN, ("Authorization", "X-Asp-Admin-Token")):
            return jsonify({"error": "unauthorized"}), 401
        return fn(*args, **kwargs)

    return wrapper


def require_postman(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not config.POSTMAN_TOKEN:
            return jsonify({"error": "ASP_POSTMAN_TOKEN not configured"}), 503
        if not _check_token(config.POSTMAN_TOKEN, ("Authorization", "X-Asp-Postman-Token")):
            return jsonify({"error": "unauthorized"}), 401
        return fn(*args, **kwargs)

    return wrapper


def require_screen_or_admin(fn):
    """F-7: metrics / ops reads."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        screen_ok = bool(config.SCREEN_TOKEN) and _check_token(config.SCREEN_TOKEN)
        admin_ok = bool(config.ADMIN_TOKEN) and _check_token(
            config.ADMIN_TOKEN, ("Authorization", "X-Asp-Admin-Token")
        )
        if screen_ok or admin_ok:
            return fn(*args, **kwargs)
        if not config.SCREEN_TOKEN and not config.ADMIN_TOKEN:
            return jsonify({"error": "ASP_SCREEN_TOKEN or ASP_ADMIN_TOKEN required"}), 503
        return jsonify({"error": "unauthorized"}), 401

    return wrapper


def _maybe_auto_publish() -> dict | None:
    if not getattr(config, "AUTO_PUBLISH_ROOT", False):
        return None
    try:
        from postman import publish_pending

        return publish_pending()
    except Exception as exc:
        log.exception("auto-publish failed: %s", exc)
        return {"ok": False, "error": "publish_failed", "message": str(exc)}


def _screen_body() -> tuple[dict | None, tuple | None]:
    body = request.get_json(silent=True) or {}
    chain_id = body.get("chainId") or body.get("chain_id")
    depositor = body.get("depositor") or body.get("address")
    if chain_id is None or not depositor:
        return None, (jsonify({"error": "chainId and depositor required"}), 400)
    try:
        chain_id = int(chain_id)
    except (TypeError, ValueError):
        return None, (jsonify({"error": "invalid chainId"}), 400)
    commitment = _text(body.get("commitment")) or None
    if commitment and not _COMMITMENT_RE.match(commitment):
        return None, (jsonify({"error": "invalid commitment"}), 400)
    return {
        "chain_id": chain_id,
        "depositor": depositor,
        "tx_hash": _text(body.get("txHash") or body.get("tx_hash")) or None,
        "commitment": commitment,
        "precommitment": _text(body.get("precommitment")) or None,
        "request_obj": body,
    }, None


@app.get("/health")
def health():
    # no listCounts / inventory on unauthenticated health
    return jsonify(
        {
            "ok": True,
            "service": "siphon-aspv2",
            "policyVersion": config.POLICY_VERSION,
            "protocolVersion": config.PROTOCOL_VERSION,
            "setId": config.SET_ID,
        }
    )


@app.get("/ready")
def ready():
    with session() as db:
        counts = list_counts(db)
    lists_ok = (counts.get("sanction", 0) + counts.get("mixer", 0)) > 0
    issues: list[str] = []
    if config.REQUIRE_SEEDED_LISTS and not lists_ok:
        issues.append("lists_unseeded")
    if config.REQUIRE_AUTH and not config.SCREEN_TOKEN:
        issues.append("screen_token_missing")
    if not zkme_configured():
        issues.append("zkme_unconfigured")
    status = 200 if not issues else 503
    # F-3: do not leak list inventory on unauthenticated ready
    return jsonify({"ready": not issues, "issues": issues}), status


@app.get("/metrics")
@require_screen_or_admin
def metrics():
    """JSON ops metrics — pending queues, dual-root drift, counters."""
    with session() as db:
        snap = dual_root_snapshot(db)
        onchain = read_onchain_roots()
        drift_a = False
        drift_r = False
        if onchain:
            drift_a = snap["admittedRoot"] != onchain.get("admittedRoot")
            drift_r = snap["revokedRoot"] != onchain.get("revokedRoot")
            set_meta(db, META_DRIFT_ADMITTED, "1" if drift_a else "0")
            set_meta(db, META_DRIFT_REVOKED, "1" if drift_r else "0")
            db.commit()
        from sqlalchemy import func, select
        from db import PendingAdmit

        pending_n = db.execute(
            select(func.count()).select_from(PendingAdmit).where(PendingAdmit.status == "pending")
        ).scalar_one()
        return jsonify(
            {
                "admittedLeafCount": snap.get("admittedLeafCount"),
                "pendingAdmitPublish": snap.get("pendingAdmitPublish"),
                "pendingRevokePublish": snap.get("pendingRevokePublish"),
                "pendingAdmitOutbox": int(pending_n or 0),
                "lastAdmitPublishTs": get_meta(db, META_LAST_ADMIT_PUBLISH_TS),
                "drift": {"admitted": drift_a, "revoked": drift_r},
                "onchain": onchain,
                "counters": {
                    "screens": int(get_meta(db, META_METRIC_SCREENS) or 0),
                    "admits": int(get_meta(db, META_METRIC_ADMITS) or 0),
                    "revokes": int(get_meta(db, META_METRIC_REVOKES) or 0),
                    "watcherAdmits": int(get_meta(db, META_METRIC_WATCHER_ADMITS) or 0),
                    "zkmeCalls": int(get_meta(db, META_METRIC_ZKME_CALLS) or 0),
                    "zkmeDenies": int(get_meta(db, META_METRIC_ZKME_DENIES) or 0),
                    "zkmeUnavailable": int(get_meta(db, META_METRIC_ZKME_UNAVAILABLE) or 0),
                },
                "listCounts": list_counts(db),
            }
        )


@app.get("/lists/stats")
@require_screen_token
def lists_stats():
    with session() as db:
        return jsonify({"counts": list_counts(db)})


@app.get("/compliance-fee/check")
@require_screen_token
def compliance_fee_check():
    """Whether wallet has an active KYT year entitlement (+ fee quote)."""
    from util import normalize_address

    wallet = (request.args.get("wallet") or "").strip()
    if not wallet:
        return jsonify({"error": "wallet query param required"}), 400
    if not normalize_address(wallet):
        return jsonify({"error": "wallet must be a 0x-prefixed 20-byte address"}), 400
    product = (request.args.get("product") or "").strip() or None
    from compliance_fee import entitlement_status, normalize_product

    try:
        prod = normalize_product(product)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    # chainId picks the vault. Optional, because a single-chain box has one vault and every
    # existing caller omits it; when it IS sent, the answer is the address that chain can actually
    # be paid into. The UI sends the fee to whatever comes back here, so a default that guesses
    # would be a default that misroutes money.
    raw_chain = (request.args.get("chainId") or "").strip()
    try:
        chain_id = int(raw_chain) if raw_chain else None
    except ValueError:
        return jsonify({"error": "chainId must be an integer"}), 400

    with session() as db:
        return jsonify(entitlement_status(db, wallet, chain_id, product=prod))


@app.post("/compliance-fee/verify")
@require_screen_token
def compliance_fee_verify():
    """Verify on-chain $0.50 payment and grant/renew 1-year KYT entitlement."""
    from util import normalize_address

    body = request.get_json(silent=True) or {}
    wallet = (body.get("wallet") or "").strip()
    tx_hash = (body.get("txHash") or body.get("tx_hash") or "").strip()
    product = (body.get("product") or "").strip() or None
    try:
        chain_id = int(body.get("chainId") or body.get("chain_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "chainId must be an integer"}), 400
    if not wallet or not tx_hash:
        return jsonify({"error": "wallet and txHash required"}), 400
    if not normalize_address(wallet):
        return jsonify({"error": "wallet must be a 0x-prefixed 20-byte address"}), 400
    if not _TX_HASH_RE.match(tx_hash):
        return jsonify({"error": "txHash must be 0x + 64 hex chars"}), 400

    from compliance_fee import FeeAlreadyPaid, FeeNotPaid, entitlement_status, normalize_product, verify_fee_payment
    from db import write_audit

    try:
        prod = normalize_product(product)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    with session() as db:
        try:
            result = verify_fee_payment(
                db, chain_id=chain_id, tx_hash=tx_hash, wallet=wallet, product=prod
            )
            write_audit(
                db,
                action="kyc_entitlement_paid" if prod == "kyc_year_v1" else "kyt_entitlement_paid",
                actor=_client_ip(),
                payload={
                    "wallet": normalize_address(wallet),
                    "txHash": tx_hash.lower(),
                    "chainId": chain_id,
                    "product": prod,
                },
            )
            db.commit()
            status = entitlement_status(db, wallet, chain_id, product=prod)
            return jsonify({"ok": True, **result, **status})
        except FeeAlreadyPaid as exc:
            db.rollback()
            status = entitlement_status(db, wallet, chain_id, product=prod)
            return jsonify({"ok": True, "alreadyPaid": True, "message": str(exc), **status})
        except FeeNotPaid as exc:
            db.rollback()
            return jsonify({"ok": False, "error": "fee_not_paid", "message": str(exc)}), 400
        except ValueError as exc:
            db.rollback()
            return jsonify({"ok": False, "error": "fee_verify_failed", "message": str(exc)}), 400


@app.post("/screen")
@require_screen_token
def screen_one():
    if not _rate_limit_ok(f"screen:{_client_ip()}"):
        return jsonify({"error": "rate_limited"}), 429
    body = request.get_json(silent=True) or {}
    params, err = _screen_body()
    if err:
        return err
    assert params is not None
    user_salt = body.get("userSalt") or body.get("user_salt")
    label_in = _text(body.get("label")) or None
    vault = _text(body.get("vault") or body.get("vaultAddress")) or None

    with session() as db:
        out = screen(db, **params)
        bump_meta_counter(db, META_METRIC_SCREENS)
        extra: dict = {}
        if out.decision == "deny":
            extra["compliance"] = handle_screen_deny(
                db,
                chain_id=params["chain_id"],
                commitment=params.get("commitment"),
                depositor=params.get("depositor"),
                label=label_in,
                reasons=out.reasons,
            )
        elif out.decision == "admit" and user_salt and params.get("commitment"):
            try:
                from pending_admit import PendingAdmitConflict, upsert_pending_admit

                upsert_pending_admit(
                    db,
                    chain_id=params["chain_id"],
                    commitment=params["commitment"],
                    user_salt=user_salt,
                    depositor=params.get("depositor"),
                    vault_address=vault,
                    label=label_in,
                )
                extra["pendingAdmit"] = True
            except PendingAdmitConflict as exc:
                db.rollback()
                return jsonify({"error": "pending_admit_conflict", "message": str(exc)}), 409
            except ValueError as exc:
                return jsonify({"error": "pending_admit_failed", "message": str(exc)}), 400
            except RuntimeError as exc:
                return jsonify({"error": "pending_admit_seal_failed", "message": str(exc)}), 503
        db.commit()
    resp = out.to_dict()
    resp.update(extra)
    # Paywall: layer1 clear but no KYT year entitlement — do not call zkMe
    if "kyt_fee_required" in (out.reasons or []):
        return jsonify(resp), 402
    return jsonify(resp)


@app.post("/screen/batch")
@require_screen_token
def screen_batch():
    """Same pending-admit / deny-cancel rules as POST /screen."""
    body = request.get_json(silent=True) or {}
    items = body.get("items") or body.get("deposits") or []
    if not isinstance(items, list) or not items:
        return jsonify({"error": "items array required"}), 400
    if len(items) > config.SCREEN_BATCH_MAX:
        return jsonify({"error": "batch too large", "max": config.SCREEN_BATCH_MAX}), 400
    # F-3: charge one RL unit per item (no batch amplification)
    if not _rate_limit_ok(f"screen:{_client_ip()}", cost=len(items)):
        return jsonify({"error": "rate_limited"}), 429
    results = []
    with session() as db:
        for item in items:
            if not isinstance(item, dict):
                results.append({"error": "invalid item"})
                continue
            chain_id = item.get("chainId") or item.get("chain_id")
            depositor = item.get("depositor") or item.get("address")
            if chain_id is None or not depositor:
                results.append({"error": "chainId and depositor required"})
                continue
            try:
                chain_id_i = int(chain_id)
            except (TypeError, ValueError):
                results.append({"error": "invalid chainId"})
                continue
            commitment = _text(item.get("commitment")) or None
            if commitment and not _COMMITMENT_RE.match(commitment):
                results.append({"error": "invalid commitment"})
                continue
            user_salt = item.get("userSalt") or item.get("user_salt")
            label_in = _text(item.get("label")) or None
            vault = _text(item.get("vault") or item.get("vaultAddress")) or None
            out = screen(
                db,
                chain_id=chain_id_i,
                depositor=depositor,
                tx_hash=_text(item.get("txHash") or item.get("tx_hash")) or None,
                commitment=commitment,
                precommitment=_text(item.get("precommitment")) or None,
                request_obj=item,
            )
            bump_meta_counter(db, META_METRIC_SCREENS)
            row = out.to_dict()
            if out.decision == "deny":
                row["compliance"] = handle_screen_deny(
                    db,
                    chain_id=chain_id_i,
                    commitment=commitment,
                    depositor=depositor,
                    label=label_in,
                    reasons=out.reasons,
                )
            elif out.decision == "admit" and user_salt and commitment:
                try:
                    from pending_admit import PendingAdmitConflict, upsert_pending_admit

                    upsert_pending_admit(
                        db,
                        chain_id=chain_id_i,
                        commitment=commitment,
                        user_salt=user_salt,
                        depositor=depositor,
                        vault_address=vault,
                        label=label_in,
                    )
                    row["pendingAdmit"] = True
                except PendingAdmitConflict as exc:
                    row["error"] = "pending_admit_conflict"
                    row["message"] = str(exc)
                except (ValueError, RuntimeError) as exc:
                    row["error"] = "pending_admit_failed"
                    row["message"] = str(exc)
            results.append(row)
        db.commit()
    fee_required = any(
        isinstance(r, dict) and "kyt_fee_required" in (r.get("reasons") or [])
        for r in results
    )
    payload = {"results": results, "feeRequired": fee_required}
    # F-3: match single /screen — any unpaid KYT item → 402
    if fee_required:
        return jsonify(payload), 402
    return jsonify(payload)


@app.get("/decisions/<commitment>")
@require_screen_token
def decision_by_commitment(commitment: str):
    chain_raw = request.args.get("chainId") or request.args.get("chain_id")
    chain_id = int(chain_raw) if chain_raw is not None else None
    with session() as db:
        row = get_decision_by_commitment(db, commitment, chain_id=chain_id)
    if not row:
        return jsonify({"error": "not_found"}), 404
    return jsonify(_decision_row(row))


@app.get("/decisions")
@require_screen_token
def decision_lookup():
    commitment = _text(request.args.get("commitment"))
    tx_hash = _text(request.args.get("txHash") or request.args.get("tx_hash"))
    chain_id = request.args.get("chainId") or request.args.get("chain_id")
    with session() as db:
        if commitment:
            cid = int(chain_id) if chain_id is not None else None
            row = get_decision_by_commitment(db, commitment, chain_id=cid)
        elif tx_hash and chain_id:
            row = get_decision_by_tx(db, int(chain_id), tx_hash)
        else:
            return jsonify({"error": "commitment or (chainId, txHash) required"}), 400
    if not row:
        return jsonify({"error": "not_found"}), 404
    return jsonify(_decision_row(row))


def _decision_row(row) -> dict:
    import json as _json

    return {
        "decision": row.decision,
        "decisionId": row.decision_id,
        "setId": config.SET_ID,
        "policyVersion": row.policy_version,
        "protocolVersion": config.PROTOCOL_VERSION,
        "commitment": row.commitment,
        "reasons": _json.loads(row.reasons),
        "checked": _json.loads(row.addresses_checked),
        "deps": _json.loads(row.deps_json),
        "createdAt": row.created_at.isoformat(),
    }


@app.post("/lists/custom_ban")
@require_admin
def custom_ban():
    body = request.get_json(silent=True) or {}
    addr = normalize_address(body.get("address"))
    if not addr:
        return jsonify({"error": "invalid address"}), 400
    note = _text(body.get("note")) or "manual ban"
    with session() as db:
        upsert_address(db, address=addr, kind="custom_ban", source="admin", note=note)
        write_audit(db, action="custom_ban", payload={"address": addr, "note": note})
        db.commit()
    return jsonify({"ok": True, "address": addr})


@app.post("/lists/custom_unban")
@require_admin
def custom_unban():
    body = request.get_json(silent=True) or {}
    addr = normalize_address(body.get("address"))
    if not addr:
        return jsonify({"error": "invalid address"}), 400
    with session() as db:
        ok = deactivate_address(db, address=addr, kind="custom_ban")
        write_audit(db, action="custom_unban", payload={"address": addr, "ok": ok})
        db.commit()
    return jsonify({"ok": ok, "address": addr})


@app.get("/set/root")
@require_screen_token
def set_root():
    with session() as db:
        snap = dual_root_snapshot(db)
    onchain = read_onchain_roots()
    if onchain:
        snap["onchainSync"] = {
            "admittedRoot": onchain.get("admittedRoot"),
            "revokedRoot": onchain.get("revokedRoot"),
            "admittedMatch": snap["admittedRoot"] == onchain.get("admittedRoot"),
            "revokedMatch": snap["revokedRoot"] == onchain.get("revokedRoot"),
        }
    if snap.get("pendingAdmitPublish") and config.AUTO_PUBLISH_ROOT:
        return jsonify({**snap, "warning": "admit_publish_pending"}), 503
    return jsonify(snap)


@app.get("/set/path")
@require_screen_token
def set_path():
    label = _text(request.args.get("label"))
    if not label:
        return jsonify({"error": "label required"}), 400
    with session() as db:
        if get_meta(db, META_PENDING_ADMIT_PUBLISH) == "1" and config.AUTO_PUBLISH_ROOT:
            return jsonify({"error": "admit_publish_pending"}), 503
        path = get_admitted_path(db, label)
    if not path:
        return jsonify({"error": "not_member"}), 404
    return jsonify(
        {
            "label": path.label,
            "admittedRoot": path.root,
            "leafIndex": path.leaf_index,
            "pathElements": path.path_elements,
            "pathIndices": path.path_indices,
        }
    )


@app.get("/solana/state/leaves")
@require_screen_token
def solana_state_leaves():
    """Ordered siphon-vault-zk state-tree leaves (deposits + spend change notes).

    The Solana program keeps only the tree frontier, and change notes are invisible to a
    DepositEvent-only scan, so clients rebuild Merkle paths from this list. Served only when the
    indexed set is contiguous and reproduces the on-chain root.

    On `leaves_incomplete` / `root_mismatch`, backfill the full vault history into Postgres by
    default, then serve — browsers must not each walk Devnet RPC for the same gaps.
    """
    from solana_chain_ids import SOLANA_DEVNET_CHAIN_ID, is_solana_chain_id
    from solana_indexer import ensure_leaves, ordered_leaves
    from solana_rpc import SolanaRpc

    raw = _text(request.args.get("chainId")) or str(SOLANA_DEVNET_CHAIN_ID)
    try:
        chain_id = int(raw)
    except ValueError:
        return jsonify({"error": "invalid chainId"}), 400
    if not is_solana_chain_id(chain_id):
        return jsonify({"error": "not a Solana chainId"}), 400
    with session() as db:
        rpc = SolanaRpc()
        check = ensure_leaves(db, rpc, chain_id=chain_id)
        if not check.get("ok"):
            return jsonify({"error": "indexer_out_of_sync", **check}), 503
        rows = ordered_leaves(db, chain_id=chain_id)
        leaves = [r.commitment for r in rows]
    return jsonify(
        {
            "chainId": chain_id,
            "leaves": leaves,
            "root": check["root"],
            "leafCount": len(leaves),
            "backfilled": bool(check.get("backfilled")),
        }
    )


@app.post("/solana/admit-pending")
@require_screen_token
def solana_admit_pending():
    """Backfill leaf index + admit every PendingAdmit that has an on-chain SolanaLeaf.

    Devnet deposits often land without the watcher running, so the association set stays empty
    (`admittedLeafCount: 0`) and withdraw dies on `asp path: label … not member`. The app
    re-screens then hits this route before proving.
    """
    from importlib import import_module

    from solana_chain_ids import SOLANA_DEVNET_CHAIN_ID, is_solana_chain_id
    from solana_indexer import ensure_leaves
    from solana_rpc import SolanaRpc

    body = request.get_json(silent=True) or {}
    raw = body.get("chainId") or body.get("chain_id") or SOLANA_DEVNET_CHAIN_ID
    try:
        chain_id = int(raw)
    except (TypeError, ValueError):
        return jsonify({"error": "invalid chainId"}), 400
    if not is_solana_chain_id(chain_id):
        return jsonify({"error": "not a Solana chainId"}), 400

    admit_pending = import_module("scripts.watch_deposits_solana").admit_pending

    with session() as db:
        rpc = SolanaRpc()
        sync = ensure_leaves(db, rpc, chain_id=chain_id)
        adm = admit_pending(db, chain_id=chain_id)
    pub = None
    try:
        from postman_solana import publish as solana_publish

        pub = solana_publish()
    except Exception as exc:
        log.warning("solana admit-pending: publish skipped: %s", exc)
        pub = {"ok": False, "error": str(exc)}
    return jsonify({"ok": True, "leaves": sync, "admit": adm, "publish": pub})


@app.post("/solana/admit-deposit")
@require_screen_token
def solana_admit_deposit():
    """Admit one Solana ZK deposit from its signature + userSalt (no watcher required).

    Verifies DepositEvent in `signature`, derives the salted label, requires a prior /screen
    admit for the commitment, then inserts into the association set and best-effort publishes
    roots on-chain.
    """
    from solana_chain_ids import SOLANA_DEVNET_CHAIN_ID, is_solana_chain_id
    from solana_indexer import _store, vault_pda, zk_program_id
    from solana_rpc import SolanaRpc, decode_leaf_events
    from util import normalize_depositor

    body = request.get_json(silent=True) or {}
    raw = body.get("chainId") or body.get("chain_id") or SOLANA_DEVNET_CHAIN_ID
    try:
        chain_id = int(raw)
    except (TypeError, ValueError):
        return jsonify({"error": "invalid chainId"}), 400
    if not is_solana_chain_id(chain_id):
        return jsonify({"error": "not a Solana chainId"}), 400

    commitment = _text(body.get("commitment"))
    user_salt = body.get("userSalt") or body.get("user_salt")
    signature = _text(body.get("signature") or body.get("depositSig") or body.get("txHash"))
    depositor = normalize_depositor(body.get("depositor"), chain_id)
    label_in = _text(body.get("label")) or None
    if not commitment or not signature or user_salt is None or str(user_salt).strip() in ("", "0"):
        return jsonify({"error": "commitment, userSalt, and signature required"}), 400
    if not depositor:
        return jsonify({"error": "depositor required"}), 400
    try:
        salt_i = int(str(user_salt).strip())
    except (TypeError, ValueError):
        return jsonify({"error": "invalid userSalt"}), 400

    rpc = SolanaRpc()
    tx = rpc.transaction(signature)
    if not tx:
        return jsonify({"error": "tx_not_found", "message": "deposit signature not found on RPC"}), 404
    events = decode_leaf_events(
        (tx.get("meta") or {}).get("logMessages") or [],
        signature=signature,
        slot=int(tx.get("slot") or 0),
    )
    deposit = next((e for e in events if e.kind == "deposit" and e.commitment == commitment), None)
    if not deposit:
        return jsonify({"error": "deposit_event_missing", "message": "no DepositEvent for this commitment"}), 400
    if deposit.depositor and deposit.depositor != depositor:
        return jsonify({"error": "depositor_mismatch"}), 403

    program_id = zk_program_id()
    vault = vault_pda(program_id)
    try:
        derived = str(
            derive_deposit_label(
                chain_id=chain_id,
                vault_address=vault,
                deposit_nonce=int(deposit.deposit_nonce or 0),
                user_salt=salt_i,
                program_id=program_id,
            )
        )
    except ValueError as exc:
        return jsonify({"error": "label_derive_failed", "message": str(exc)}), 400
    if label_in is not None and str(int(label_in)) != str(int(derived)):
        return jsonify({"error": "label_mismatch", "message": "client label ≠ derived label"}), 400
    label = derived

    with session() as db:
        try:
            verify_screen_admit_binding(
                db,
                commitment=commitment,
                chain_id=chain_id,
                tx_hash=signature,
                depositor=depositor,
            )
        except ValueError as exc:
            return jsonify({"error": "screen_binding_failed", "message": str(exc)}), 403

        if is_admitted(db, label):
            result = {"label": label, "alreadyAdmitted": True}
        else:
            result = admit_label(
                db,
                label=label,
                chain_id=chain_id,
                vault_address=vault,
                deposit_nonce=int(deposit.deposit_nonce or 0),
                depositor=depositor,
                commitment=commitment,
            )
            bump_meta_counter(db, META_METRIC_ADMITS)
            write_audit(
                db,
                action="solana_admit_deposit",
                payload={"label": label, "signature": signature, "commitment": commitment},
            )
        # Keep the leaf index table in sync for the watcher / leaves endpoint.
        try:
            _store(db, chain_id, deposit)
        except Exception:
            log.exception("solana admit-deposit: leaf store skipped")
        from pending_admit import get_pending_by_commitment, mark_pending_admitted

        pend = get_pending_by_commitment(db, chain_id, commitment)
        if pend and pend.status == "pending":
            mark_pending_admitted(db, pend, tx_hash=signature, label=label)
        db.commit()

    pub = None
    try:
        from postman_solana import publish as solana_publish

        pub = solana_publish()
    except Exception as exc:
        log.warning("solana admit-deposit: publish skipped: %s", exc)
        pub = {"ok": False, "error": str(exc)}
    return jsonify({"ok": True, "label": label, "admit": result, "publish": pub})


@app.post("/solana/publish-roots")
@require_screen_token
def solana_publish_roots():
    """Publish the current admitted and revoked roots onto the Solana compliance PDA.

    A withdraw proves the note's label against the ASP's current roots. The app refuses that
    path with publish_pending until `publish_roots` has landed. Admit already tries this, and
    skips it once the label is a member — so a later root (or a publish that failed at admit
    time) never reaches the chain. Withdraw calls this to close that gap. No-op when the PDA
    already matches.
    """
    from solana_chain_ids import SOLANA_DEVNET_CHAIN_ID, is_solana_chain_id

    body = request.get_json(silent=True) or {}
    raw = body.get("chainId") or body.get("chain_id") or SOLANA_DEVNET_CHAIN_ID
    try:
        chain_id = int(raw)
    except (TypeError, ValueError):
        return jsonify({"error": "invalid chainId"}), 400
    if not is_solana_chain_id(chain_id):
        return jsonify({"error": "not a Solana chainId"}), 400
    try:
        from postman_solana import publish as solana_publish

        pub = solana_publish()
    except Exception as exc:
        log.warning("solana publish-roots failed: %s", exc)
        return jsonify({"ok": False, "error": "publish_failed", "message": str(exc)}), 503
    return jsonify({"ok": True, "publish": pub})


def _snapshot_binding(explicit: str) -> tuple[int, str] | None:
    """`(chainId, hub)` to bind into the snapshot signature, or None if it cannot be determined.

    Binding both means a snapshot signed for one deployment cannot be replayed at an enclave
    watching another — the same reason `ComplianceHub.ATTEST_TYPEHASH` binds chainId and hub.
    """
    # Deliberately the explicit per-chain map only, NEVER config.compliance_hub_address()'s generic
    # ASP_COMPLIANCE_HUB fallback: that fallback answers for every chain id, so routing through it
    # would happily sign "chainId 8453, hub <the Sepolia hub>" — binding the wrong deployment,
    # which is the precise replay this signature exists to prevent.
    if explicit:
        try:
            cid = int(explicit)
        except ValueError:
            return None
        hub = config.COMPLIANCE_HUB_BY_CHAIN.get(cid)
        return (cid, hub) if hub else None
    # No chainId asked for: only unambiguous when exactly one hub is configured. Guessing between
    # several would sign for the wrong deployment, which is worse than not signing.
    if len(config.COMPLIANCE_HUB_BY_CHAIN) == 1:
        return next(iter(config.COMPLIANCE_HUB_BY_CHAIN.items()))
    return None


@app.get("/set/leaves")
@require_screen_token
def set_leaves():
    """Full admitted + revoked leaf sets, so a caller can rebuild both trees and derive its OWN
    paths locally.

    Exists for the fire-time prover in the TEE. `/set/path?label=…` would work, but a per-label
    lookup at fire time correlates in real time with the spend that lands on-chain moments later,
    handing this service a deposit -> spend link it does not otherwise have. Syncing the whole set
    removes the query, and with it the correlation.

    Returns leaves in leaf-index order — order IS the tree. Callers MUST rebuild and check the
    reconstructed root against `admittedRoot`/`revokedRoot` here (and against the chain) before
    trusting a locally-derived path; a silently truncated list still produces a well-formed path
    that fails the circuit's AspInclusion assert, which reads as a proving bug rather than a sync
    bug (exactly how the insertion-time-path regression presented).

    Not more disclosure than the set already makes: labels are opaque field elements that name no
    depositor, and the admitted COUNT is already public via /set/root. Same screen-token gate as
    every other /set route.
    """
    # Pass ?chainId= to get a signed snapshot. The enclave MUST: it will not attest freshness
    # against an unsigned one (see snapshot_sig.py for why the old caller-supplied roots were
    # circular). Omitting it stays supported for callers that only want the leaf sets.
    want = _text(request.args.get("chainId")) or _text(request.args.get("chain_id"))
    binding = _snapshot_binding(want)
    if want and binding is None:
        # Explicitly asking to be bound to a chain we cannot bind to is a misconfiguration, not a
        # degraded mode. Failing loudly here beats an enclave rejecting "unsigned" hours later.
        return jsonify({"error": "no_compliance_hub_for_chain", "chainId": want}), 400

    with session() as db:
        if get_meta(db, META_PENDING_ADMIT_PUBLISH) == "1" and config.AUTO_PUBLISH_ROOT:
            return jsonify({"error": "admit_publish_pending"}), 503
        snap = dual_root_snapshot(db)
        admitted = [str(x) for x in _load_labels_ordered(db)]
        revoked = [str(x) for x in _load_revoked_labels(db)]

    body = {
        "admittedRoot": snap["admittedRoot"],
        "revokedRoot": snap["revokedRoot"],
        # Index i in this list IS leaf index i. Do not sort.
        "admittedLabels": admitted,
        "admittedCount": len(admitted),
        # Order is irrelevant for the SMT (position is derived from the key), but stable.
        "revokedLabels": revoked,
        "revokedCount": len(revoked),
    }

    if binding is not None:
        chain_id, hub = binding
        # Per-chain: the enclave checks this signature against the postman address registered on
        # THAT chain's hub, so signing a Base snapshot with the Sepolia key would fail verification
        # inside the CVM at fire time — after the strategy was armed.
        pk = config.postman_key(chain_id)
        if not pk:
            # PRODUCTION_LOCK already requires the key, so this is a dev/test path only.
            if config.PRODUCTION_LOCK:
                return jsonify({"error": "postman_key_unavailable"}), 500
        else:
            # issuedAt is what makes an old snapshot detectable as old; the enclave enforces a max
            # age against it. Signed AFTER the read so it timestamps the roots actually served.
            issued_at = int(time.time())
            body["issuedAt"] = issued_at
            body["snapshotSig"] = sign_snapshot(
                private_key=pk,
                chain_id=chain_id,
                hub=hub,
                admitted_root=int(snap["admittedRoot"]),
                revoked_root=int(snap["revokedRoot"]),
                issued_at=issued_at,
            )
            body["snapshotChainId"] = chain_id
            body["snapshotHub"] = hub

    return jsonify(body)


@app.get("/set/smt-path")
@require_screen_token
def set_smt_path():
    label = _text(request.args.get("label"))
    if not label:
        return jsonify({"error": "label required"}), 400
    with session() as db:
        path = get_smt_non_inclusion_path(db, label)
    if not path:
        return jsonify({"error": "path_unavailable"}), 404
    from core.domains import load_domains, smt_leaf_hash

    domains = load_domains()
    # Circom SmtNonInclusion.leaf = claimed/actual slot leaf (claimedLeaf).
    # labelLeafHash = leafHash(label) for forensics / inequality checks — not Circom input.
    my_leaf = smt_leaf_hash(int(path.label), domains["DOMAIN_SMT_LEAF"])
    return jsonify(
        {
            "label": path.label,
            "revokedRoot": path.root,
            "pathElements": path.path_elements,
            "pathIndices": path.path_indices,
            "claimedLeaf": path.claimed_leaf,
            "labelLeafHash": str(my_leaf),
            # Deprecated alias of labelLeafHash — SDK maps Circom leaf from claimedLeaf.
            "revokedSmtLeaf": str(my_leaf),
        }
    )


@app.get("/set/smt-inclusion-path")
@require_screen_token
def set_smt_inclusion_path():
    label = _text(request.args.get("label"))
    if not label:
        return jsonify({"error": "label required"}), 400
    with session() as db:
        path = get_smt_inclusion_path(db, label)
    if not path:
        return jsonify({"error": "not_revoked"}), 404
    return jsonify(
        {
            "label": path.label,
            "revokedRoot": path.root,
            "pathElements": path.path_elements,
            "pathIndices": path.path_indices,
            "claimedLeaf": path.claimed_leaf,
        }
    )


@app.get("/set/member")
@require_screen_token
def set_member():
    label = _text(request.args.get("label"))
    if not label:
        return jsonify({"error": "label required"}), 400
    if not _rate_limit_ok(f"member:{_client_ip()}"):
        return jsonify({"error": "rate_limited"}), 429
    with session() as db:
        admitted = is_admitted(db, label)
        revoked = is_revoked(db, label)
    return jsonify({"label": label, "admitted": admitted, "revoked": revoked, "member": admitted})


@app.post("/set/admit")
@require_postman
def set_admit():
    body = request.get_json(silent=True) or {}
    label = body.get("label")
    tx_hash = _text(body.get("txHash") or body.get("tx_hash"))
    vault = _text(body.get("vault") or body.get("vaultAddress"))
    chain_id = body.get("chainId") or body.get("chain_id")
    commitment = _text(body.get("commitment")) or None
    user_salt = body.get("userSalt") or body.get("user_salt")
    skip_screen = _truthy(body.get("skipScreenCheck") or body.get("skip_screen"))

    if not tx_hash or not vault or chain_id is None:
        return jsonify({"error": "txHash, vault, chainId required"}), 400
    if commitment and not _COMMITMENT_RE.match(commitment):
        return jsonify({"error": "invalid commitment"}), 400
    try:
        chain_id = int(chain_id)
    except (TypeError, ValueError):
        return jsonify({"error": "invalid chainId"}), 400
    depositor = normalize_depositor(body.get("depositor"), chain_id)
    if not _TX_HASH_RE.match(tx_hash):
        return jsonify({"error": "invalid txHash"}), 400

    # PROTOCOL: label = mint(scope, nonce, userSalt). Salt required unless explicitly allowed.
    if user_salt is None or str(user_salt).strip() in ("", "0"):
        if config.REQUIRE_USER_SALT and not config.ALLOW_CLIENT_LABEL:
            return jsonify({"error": "userSalt_required", "message": "non-zero userSalt required to derive label"}), 400
        if label is None:
            return jsonify({"error": "label or userSalt required"}), 400
    else:
        user_salt = str(user_salt).strip()

    if skip_screen:
        ok, code = config.skip_screen_allowed(chain_id)
        if not ok:
            return jsonify({"error": code}), 403

    try:
        dep_ev = verify_deposited(
            tx_hash=tx_hash,
            chain_id=chain_id,
            vault=vault,
            commitment=commitment,
            depositor=depositor,
            user_salt=int(user_salt) if user_salt is not None else None,
            label=label,
        )
    except ValueError as exc:
        return jsonify({"error": "chain_verify_failed", "message": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"error": "chain_unavailable", "message": str(exc)}), 503

    # Derive label from salt when present (authoritative).
    if user_salt is not None:
        derived = derive_deposit_label(
            chain_id=chain_id,
            vault_address=vault,
            deposit_nonce=int(dep_ev["depositNonce"]),
            user_salt=int(user_salt),
        )
        if label is not None and str(int(label)) != str(derived):
            return jsonify(
                {
                    "error": "label_mismatch",
                    "message": "client label ≠ derive_deposit_label(nonce, userSalt)",
                }
            ), 400
        label = str(derived)

    with session() as db:
        if not skip_screen:
            try:
                verify_screen_admit_binding(
                    db,
                    commitment=commitment or dep_ev.get("commitment"),
                    chain_id=chain_id,
                    tx_hash=tx_hash,
                    depositor=depositor or dep_ev.get("depositor"),
                )
            except ValueError as exc:
                return jsonify({"error": "screen_binding_failed", "message": str(exc)}), 403

        result = admit_label(
            db,
            label=label,
            chain_id=chain_id,
            vault_address=vault,
            deposit_nonce=dep_ev.get("depositNonce"),
            depositor=depositor or dep_ev.get("depositor"),
            commitment=dep_ev.get("commitment"),
            amount=dep_ev.get("amount"),
            asset_id=_asset_id_from_token(dep_ev.get("token")),
        )
        bump_meta_counter(db, META_METRIC_ADMITS)
        # Clear outbox salt if present
        from pending_admit import get_pending_by_commitment, mark_pending_admitted

        pend = get_pending_by_commitment(db, chain_id, str(dep_ev.get("commitment") or commitment or ""))
        if pend and pend.status == "pending":
            mark_pending_admitted(db, pend, tx_hash=tx_hash, label=str(label))
        write_audit(db, action="set_admit", payload={"label": str(label), "txHash": tx_hash})
        db.commit()

    pub = _maybe_auto_publish()
    return jsonify({**result, "publish": pub})


def _revoke_by_rule_one_two(body: dict, *, reason: str):
    """Freeze `amount` of a depositor's value by revoking one selected label.

    O-7 / §7.3 atomic revoke: every SMT insert lands in one transaction and one
    _maybe_auto_publish(), so the published revokedRoot moves exactly once and
    the event stays root-only (never labels[]).
    """
    from rule_one_two import canonical_amount, canonical_asset_id, select_labels_to_freeze

    depositor = normalize_address(body.get("depositor"))
    if not depositor:
        return jsonify({"error": "depositor required for amount-based revoke"}), 400

    asset_id = body.get("assetId") or body.get("asset_id")
    if asset_id is None:
        return jsonify({"error": "assetId required for amount-based revoke"}), 400

    try:
        amount_x = canonical_amount(body.get("amount"))
        asset = canonical_asset_id(asset_id)
    except ValueError as exc:
        return jsonify({"error": "invalid_request", "message": str(exc)}), 400

    flagged_label = body.get("flaggedLabel") or body.get("flagged_label")
    if flagged_label is not None:
        try:
            flagged_label = canonical_label(flagged_label)
        except ValueError as exc:
            return jsonify({"error": "invalid_label", "message": str(exc)}), 400

    with session() as db:
        try:
            sel = select_labels_to_freeze(
                db,
                depositor=depositor,
                amount_x=amount_x,
                asset_id=asset,
                flagged_label=flagged_label,
            )
        except ValueError as exc:
            return jsonify({"error": "invalid_request", "message": str(exc)}), 400

        # Nothing fits: the value already left the pool, so there is nothing to
        # freeze. 200 — the request was processed, the answer is "no fit".
        if not sel.labels:
            write_audit(
                db,
                action="set_revoke_rule_1_2",
                payload={
                    "mode": "rule_1_2",
                    "depositor": depositor,
                    "assetId": asset,
                    **sel.as_dict(),
                },
            )
            db.commit()
            return jsonify({"revoked": False, "mode": "rule_1_2", **sel.as_dict()})

        results = []
        for lab in sel.labels:
            res = revoke_label(db, label=lab, reason=reason)
            results.append(res)
            # Selection already excludes revoked labels, so this is the fresh-insert
            # path; guard the counter anyway so a future selection change cannot
            # inflate the metric with no-op re-revokes.
            if res.get("revoked"):
                bump_meta_counter(db, META_METRIC_REVOKES)

        write_audit(
            db,
            action="set_revoke_rule_1_2",
            payload={
                "mode": "rule_1_2",
                "depositor": depositor,
                "assetId": asset,
                "reason": reason,
                "flaggedLabel": flagged_label,
                **sel.as_dict(),
            },
        )
        root = current_revoked_root(db)
        db.commit()

    # One publish for the whole selection (atomic revoke).
    pub = _maybe_auto_publish()
    return jsonify(
        {
            "revoked": any(r.get("revoked") for r in results),
            "mode": "rule_1_2",
            "root": root,
            "results": results,
            **sel.as_dict(),
            "publish": pub,
        }
    )


@app.post("/set/revoke")
@require_postman
def set_revoke():
    body = request.get_json(silent=True) or {}
    label = body.get("label")
    reason = _text(body.get("reason")) or "compliance_revoke"

    # Exit ticket (PROTOCOL §5.2.1, F-8): a depositor who is never admitted has NO other way out.
    # RAGEQUIT branch0 needs admittedRoot == EMPTY_ASP_ROOT, and ComplianceHub refuses to
    # re-publish a seen root, so branch0 dies at bootstrap; branch1 needs SMT inclusion. The spec
    # table says exactly that: "pre-admit exit | label ∉ ASP (typical) | label ∈ SMT | Revoked",
    # and F-8 calls it an "ops exit ticket". The is_admitted() guard below forbids the very row
    # the spec mandates, which strands the funds of anyone denied at the admit-time recheck —
    # deposit() is permissionless, so the chain lets them in and only the ASP can let them out.
    #
    # We keep the F-4 anti-pollution property by proving the label instead of assuming it: it must
    # derive from a real Deposited event at the pinned vault, so arbitrary field elements still
    # cannot enter the SMT and growth stays bounded by actual deposits.
    tx_hash = _text(body.get("txHash"))
    user_salt = body.get("userSalt")
    proven = False
    if tx_hash and user_salt is not None:
        chain_id = body.get("chainId") or body.get("chain_id")
        vault = _text(body.get("vault"))
        if chain_id is None or not vault:
            return jsonify({"error": "chainId and vault required with txHash"}), 400
        try:
            dep_ev = verify_deposited(
                tx_hash=tx_hash,
                chain_id=int(chain_id),
                vault=vault,
                depositor=_text(body.get("depositor")) or None,
            )
            derived = str(
                derive_deposit_label(
                    chain_id=int(chain_id),
                    vault_address=vault,
                    deposit_nonce=int(dep_ev["depositNonce"]),
                    user_salt=int(user_salt),
                )
            )
        except ValueError as exc:
            return jsonify({"error": "chain_verify_failed", "message": str(exc)}), 400
        except RuntimeError as exc:
            return jsonify({"error": "chain_unavailable", "message": str(exc)}), 503
        if label is not None and str(int(label)) != derived:
            return jsonify(
                {
                    "error": "label_mismatch",
                    "message": "label ≠ derive_deposit_label(nonce, userSalt)",
                }
            ), 400
        label, proven = derived, True

    # Rule 1/2 selection (after-merge compliance freeze — see rule_one_two.py).
    # Body {depositor, amount, assetId} with no explicit label: the ASP picks
    # which live label to freeze rather than the caller naming it. Existing
    # {label} and exit-ticket paths above are unchanged.
    req_amount = body.get("amount")
    if label is None and req_amount is not None:
        return _revoke_by_rule_one_two(body, reason=reason)

    if label is None:
        return jsonify({"error": "label required"}), 400

    with session() as db:
        if is_revoked(db, label):
            return jsonify({"skipped": True, "reason": "already_revoked", "label": str(label)})
        # F-4: refuse SMT pollution with labels never admitted (unless proven above)
        if not proven and not is_admitted(db, label) and not config.ALLOW_REVOKE_UNADMITTED:
            return jsonify(
                {
                    "error": "not_admitted",
                    "message": (
                        "label must be in ASP before revoke — or pass txHash + userSalt + "
                        "chainId + vault to prove it from the Deposited event (exit ticket)"
                    ),
                }
            ), 400
        result = revoke_label(db, label=label, reason=reason)
        bump_meta_counter(db, META_METRIC_REVOKES)
        write_audit(
            db,
            action="set_revoke",
            payload={"label": str(label), "reason": reason, "exitTicket": proven},
        )
        db.commit()

    pub = _maybe_auto_publish()
    return jsonify({**result, "publish": pub})


def main() -> None:
    host = os.getenv("ASP_BIND", "127.0.0.1")
    port = int(os.getenv("ASP_PORT", "5056"))
    # F-7: debug only via explicit ASP_DEBUG (never implied by non-prod)
    app.run(host=host, port=port, debug=bool(config.FLASK_DEBUG))


if __name__ == "__main__":
    main()
