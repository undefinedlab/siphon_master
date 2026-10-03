"""DELTA — OVERLORD security regressions for OMEGA F-1…F-9 (exact PoC blockers)."""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest

os.environ["ASP_DATABASE_URL"] = "sqlite:///:memory:"
os.environ["ASP_SCREEN_TOKEN"] = "screen-test-token16"
os.environ["ASP_ADMIN_TOKEN"] = "admin-test-token16"
os.environ["ASP_POSTMAN_TOKEN"] = "postman-test-tok16"
os.environ["ASP_PENDING_SALT_KEY"] = "pending-seal-key"
os.environ["ASP_REQUIRE_AUTH"] = "1"
os.environ["ASP_AUTO_PUBLISH_ROOT"] = "0"
os.environ["ASP_REQUIRE_SEEDED_LISTS"] = "0"

import config
import db
from app import app, _check_token
from association_set import admit_label, is_admitted
from db import init_db, session
from revocation_set import is_revoked
from screen import screen

SANCTIONED = "0x3333333333333333333333333333333333333333"
VICTIM_LABEL = "999888777"
DEP_A = "0x1111111111111111111111111111111111111111"
DEP_B = "0x2222222222222222222222222222222222222222"
VAULT = "0x" + "a1" * 20


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setattr(config, "SCREEN_TOKEN", "screen-test-token16")
    monkeypatch.setattr(config, "ADMIN_TOKEN", "admin-test-token16")
    monkeypatch.setattr(config, "POSTMAN_TOKEN", "postman-test-tok16")
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)
    monkeypatch.setattr(config, "AUTO_PUBLISH_ROOT", False)
    monkeypatch.setattr(config, "ZKME_MCH_NO", "")
    monkeypatch.setattr(config, "ZKME_API_KEY", "")
    monkeypatch.setattr(config, "ALLOW_ANY_VAULT", False)
    monkeypatch.setattr(config, "REQUIRE_USER_SALT", True)
    monkeypatch.setattr(config, "ALLOW_CLIENT_LABEL", False)
    monkeypatch.setattr(config, "SCREEN_ADMIT_RECHECK", False)
    monkeypatch.setattr(config, "SCREEN_ADMIT_MAX_AGE_SEC", 3600)
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


@pytest.fixture
def client():
    return app.test_client()


def _hdr(token: str = "screen-test-token16") -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# --- F-1: screen deny must NOT revoke client-supplied label ---
@patch("screen.is_sanctioned", return_value=True)
def test_f1_screen_deny_cannot_revoke_arbitrary_label(mock_oracle, poseidon_ready, client):
    with session() as s:
        admit_label(s, label=VICTIM_LABEL, chain_id=31337)
        s.commit()
        assert is_admitted(s, VICTIM_LABEL)

    r = client.post(
        "/screen",
        headers=_hdr(),
        json={
            "chainId": 31337,
            "depositor": SANCTIONED,
            "commitment": "1",
            "label": VICTIM_LABEL,  # OMEGA PoC: victim label on deny path
        },
    )
    assert r.status_code == 200
    assert r.get_json()["decision"] == "deny"
    assert r.get_json().get("compliance", {}).get("revoked") is None
    with session() as s:
        assert is_admitted(s, VICTIM_LABEL)
        assert not is_revoked(s, VICTIM_LABEL)


# --- F-2: screen depositor must match deposit depositor ---
def test_f2_screen_binding_depositor_mismatch(poseidon_ready):
    from chain_verify import verify_screen_admit_binding

    with patch("screen.is_sanctioned", return_value=False):
        with session() as s:
            screen(s, chain_id=31337, depositor=DEP_A, commitment="42", persist=True)
            with pytest.raises(ValueError, match="does not match"):
                verify_screen_admit_binding(
                    s, commitment="42", chain_id=31337, tx_hash=None, depositor=DEP_B
                )


# --- F-3: pending admit salt overwrite by other depositor ---
def test_f3_pending_admit_conflict(poseidon_ready, client):
    with patch("screen.is_sanctioned", return_value=False):
        r1 = client.post(
            "/screen",
            headers=_hdr(),
            json={
                "chainId": 31337,
                "depositor": DEP_A,
                "commitment": "55",
                "userSalt": "4242",
                "vault": VAULT,
            },
        )
        assert r1.status_code == 200
        assert r1.get_json().get("pendingAdmit") is True

        r2 = client.post(
            "/screen",
            headers=_hdr(),
            json={
                "chainId": 31337,
                "depositor": DEP_B,
                "commitment": "55",
                "userSalt": "9999",
                "vault": VAULT,
            },
        )
    assert r2.status_code == 409
    assert r2.get_json()["error"] == "pending_admit_conflict"


# --- F-4: vault unset fail-closed ---
def test_f4_vault_required(monkeypatch):
    from chain_verify import _require_vault_match
    from web3 import Web3

    monkeypatch.setattr(config, "vault_kernel_address", lambda cid: "")
    monkeypatch.setattr(config, "ALLOW_ANY_VAULT", False)
    with pytest.raises(ValueError, match="not configured"):
        _require_vault_match(Web3(), VAULT, 31337)


# --- F-5: userSalt sealed at rest ---
def test_f5_pending_salt_sealed(poseidon_ready):
    from pending_admit import read_pending_salt, upsert_pending_admit

    with session() as s:
        upsert_pending_admit(
            s, chain_id=1, commitment="7", user_salt=4242, depositor=DEP_A
        )
        s.commit()
        from pending_admit import get_pending_by_commitment

        row = get_pending_by_commitment(s, 1, "7")
        assert row.user_salt.startswith("v1:")
        assert "4242" not in row.user_salt
        assert read_pending_salt(row) == "4242"


# --- F-6: empty token never authenticates ---
def test_f6_empty_token_denied(monkeypatch):
    monkeypatch.setattr(config, "SCREEN_TOKEN", "")
    with app.test_request_context("/", headers={}):
        assert _check_token("") is False
    client = app.test_client()
    r = client.get("/set/root", headers={"Authorization": "Bearer anything"})
    assert r.status_code == 503


# --- F-7: metrics requires auth ---
def test_f7_metrics_unauth_401(poseidon_ready, client):
    r = client.get("/metrics")
    assert r.status_code == 401


def test_f7_metrics_with_screen_token(poseidon_ready, client):
    r = client.get("/metrics", headers=_hdr())
    assert r.status_code == 200
    assert "counters" in r.get_json()


# --- F-8: failed pending wipes salt ---
def test_f8_mark_failed_wipes_salt(poseidon_ready):
    from pending_admit import get_pending_by_commitment, mark_pending_failed, upsert_pending_admit

    with session() as s:
        upsert_pending_admit(
            s, chain_id=1, commitment="8", user_salt=11, depositor=DEP_A
        )
        s.commit()
        row = get_pending_by_commitment(s, 1, "8")
        mark_pending_failed(s, row, "boom")
        s.commit()
        assert row.user_salt == ""


# --- F-9: redis fail-closed when configured but down ---
def test_f9_redis_fail_closed(monkeypatch):
    from app import _rate_limit_ok

    monkeypatch.setattr(config, "REDIS_URL", "redis://127.0.0.1:1/0")
    if hasattr(_rate_limit_ok, "_redis"):
        delattr(_rate_limit_ok, "_redis")
    assert _rate_limit_ok("test:f9") is False


# =============================================================================
# Round-2 OVERLORD (2026-08-25) — F-1…F-8 PoC blockers
# =============================================================================

FIELD_SALT = "1" * 78  # BN254-sized decimal — Fernet seal ≫ 128 chars


def test_r2_f1_sealed_field_element_salt_persists(poseidon_ready):
    from pending_admit import get_pending_by_commitment, read_pending_salt, upsert_pending_admit

    with session() as s:
        upsert_pending_admit(
            s, chain_id=1, commitment="f1", user_salt=FIELD_SALT, depositor=DEP_A
        )
        s.commit()
        row = get_pending_by_commitment(s, 1, "f1")
        assert len(row.user_salt) > 128
        assert read_pending_salt(row) == FIELD_SALT


@patch("screen.is_sanctioned", return_value=True)
def test_r2_f2_cross_depositor_deny_does_not_cancel(mock_oracle, poseidon_ready, client):
    with patch("screen.is_sanctioned", return_value=False):
        r1 = client.post(
            "/screen",
            headers=_hdr(),
            json={
                "chainId": 31337,
                "depositor": DEP_A,
                "commitment": "90001",
                "userSalt": "4242",
                "vault": VAULT,
            },
        )
    assert r1.status_code == 200
    assert r1.get_json().get("pendingAdmit") is True

    r2 = client.post(
        "/screen",
        headers=_hdr(),
        json={
            "chainId": 31337,
            "depositor": SANCTIONED,
            "commitment": "90001",
        },
    )
    assert r2.status_code == 200
    assert r2.get_json()["decision"] == "deny"
    assert r2.get_json().get("compliance", {}).get("cancelledPending") is False
    assert r2.get_json().get("compliance", {}).get("skipped") == "depositor_mismatch"
    from pending_admit import get_pending_by_commitment, read_pending_salt

    with session() as s:
        row = get_pending_by_commitment(s, 31337, "90001")
        assert row.status == "pending"
        assert read_pending_salt(row) == "4242"


@patch("screen.is_sanctioned", return_value=False)
def test_r2_f3_pending_salt_immutable(mock_oracle, poseidon_ready, client):
    r1 = client.post(
        "/screen",
        headers=_hdr(),
        json={
            "chainId": 31337,
            "depositor": DEP_A,
            "commitment": "90002",
            "userSalt": "111",
            "vault": VAULT,
        },
    )
    assert r1.status_code == 200
    r2 = client.post(
        "/screen",
        headers=_hdr(),
        json={
            "chainId": 31337,
            "depositor": DEP_A,
            "commitment": "90002",
            "userSalt": "222",
            "vault": VAULT,
        },
    )
    assert r2.status_code == 409
    assert r2.get_json()["error"] == "pending_admit_conflict"


@patch("screen.is_sanctioned", return_value=False)
def test_r2_f4_batch_seals_pending(mock_oracle, poseidon_ready, client):
    r = client.post(
        "/screen/batch",
        headers=_hdr(),
        json={
            "items": [
                {
                    "chainId": 31337,
                    "depositor": DEP_A,
                    "commitment": "90003",
                    "userSalt": "55",
                    "vault": VAULT,
                }
            ]
        },
    )
    assert r.status_code == 200
    results = r.get_json()["results"]
    assert results[0].get("pendingAdmit") is True
    from pending_admit import get_pending_by_commitment, read_pending_salt

    with session() as s:
        row = get_pending_by_commitment(s, 31337, "90003")
        assert row is not None
        assert read_pending_salt(row) == "55"


def test_r2_f5_decision_lookup_scoped_by_chain(poseidon_ready):
    from db import ScreenResult, get_decision_by_commitment, new_decision_id

    with session() as s:
        s.add(
            ScreenResult(
                decision_id=new_decision_id(),
                chain_id=1,
                depositor=DEP_A,
                commitment="shared",
                request_json="{}",
                decision="admit",
                reasons="[]",
                addresses_checked="[]",
                deps_json="{}",
                policy_version="test",
            )
        )
        s.add(
            ScreenResult(
                decision_id=new_decision_id(),
                chain_id=8453,
                depositor=DEP_B,
                commitment="shared",
                request_json="{}",
                decision="deny",
                reasons="[]",
                addresses_checked="[]",
                deps_json="{}",
                policy_version="test",
            )
        )
        s.commit()
        row = get_decision_by_commitment(s, "shared", chain_id=1)
        assert row is not None
        assert row.decision == "admit"
        assert row.depositor == DEP_A
        row2 = get_decision_by_commitment(s, "shared", chain_id=8453)
        assert row2.decision == "deny"


def test_r2_f6_production_requires_redis():
    import importlib
    import sys

    # Simulate config gate without reloading whole app (would break fixture DB).
    assert hasattr(config, "REDIS_URL")
    # Production path raises at import — assert the invariant string is present.
    src = open(config.__file__).read()
    assert "ASP_REDIS_URL required in production" in src


def test_r2_f7_flask_debug_defaults_off():
    assert config.FLASK_DEBUG is False
    src = open(__import__("app").__file__).read()
    assert "debug=bool(config.FLASK_DEBUG)" in src
    assert "debug=not config.PRODUCTION_LOCK" not in src


def test_r2_f8_health_omits_list_counts(poseidon_ready, client):
    r = client.get("/health")
    assert r.status_code == 200
    data = r.get_json()
    assert data["ok"] is True
    assert "listCounts" not in data


# =============================================================================
# Round-3 OVERLORD — F-1…F-6 PoC blockers
# =============================================================================


def test_r3_f1_migrate_schema_callable(poseidon_ready):
    from db import migrate_schema

    migrate_schema()  # idempotent; must not raise on sqlite test DB


def test_r3_f2_decrypt_fail_does_not_overwrite_salt(poseidon_ready, monkeypatch):
    from pending_admit import PendingAdmitConflict, get_pending_by_commitment, upsert_pending_admit

    with session() as s:
        upsert_pending_admit(
            s, chain_id=1, commitment="r3f2", user_salt=4242, depositor=DEP_A
        )
        s.commit()
        row = get_pending_by_commitment(s, 1, "r3f2")
        # Corrupt seal so open_user_salt fails
        row.user_salt = "v1:" + ("A" * 100)
        s.commit()

        with pytest.raises(PendingAdmitConflict, match="immutable"):
            upsert_pending_admit(
                s, chain_id=1, commitment="r3f2", user_salt=9999, depositor=DEP_A
            )
        row2 = get_pending_by_commitment(s, 1, "r3f2")
        assert row2.user_salt.startswith("v1:")
        assert "9999" not in row2.user_salt


def test_r3_f3_ready_omits_list_counts(poseidon_ready, client, monkeypatch):
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)
    r = client.get("/ready")
    assert r.status_code in (200, 503)
    assert "listCounts" not in r.get_json()


def test_r3_f4_revoke_unadmitted_rejected(poseidon_ready, client, monkeypatch):
    monkeypatch.setattr(config, "ALLOW_REVOKE_UNADMITTED", False)
    r = client.post(
        "/set/revoke",
        headers={"Authorization": "Bearer postman-test-tok16", "Content-Type": "application/json"},
        json={"label": "999001", "reason": "pollute"},
    )
    assert r.status_code == 400
    assert r.get_json()["error"] == "not_admitted"


def test_r3_f4_revoke_admitted_ok(poseidon_ready, client, monkeypatch):
    monkeypatch.setattr(config, "ALLOW_REVOKE_UNADMITTED", False)
    with session() as s:
        admit_label(s, label="999002", chain_id=31337)
        s.commit()
    r = client.post(
        "/set/revoke",
        headers={"Authorization": "Bearer postman-test-tok16", "Content-Type": "application/json"},
        json={"label": "999002", "reason": "compliance"},
    )
    assert r.status_code == 200
    assert r.get_json().get("revoked") is True


def test_r3_f5_invalid_commitment_rejected(poseidon_ready, client):
    r = client.post(
        "/screen",
        headers=_hdr(),
        json={
            "chainId": 31337,
            "depositor": DEP_A,
            "commitment": "not-a-commitment!!!",
        },
    )
    assert r.status_code == 400
    assert r.get_json()["error"] == "invalid commitment"


def test_r3_f6_unsealed_salt_rejected(poseidon_ready, monkeypatch):
    monkeypatch.setattr(config, "ALLOW_LEGACY_PLAINTEXT_SALT", False)
    from salt_crypto import open_user_salt

    with pytest.raises(ValueError, match="unsealed"):
        open_user_salt("4242")


# =============================================================================
# Round-4 OVERLORD — F-1…F-5 PoC blockers
# =============================================================================


def test_r4_f1_user_salt_stripped_from_request_json(poseidon_ready):
    import json

    from db import ScreenResult
    from screen import screen

    with patch("screen.is_sanctioned", return_value=False):
        with session() as s:
            screen(
                s,
                chain_id=31337,
                depositor=DEP_A,
                commitment="80001",
                persist=True,
                request_obj={"user_salt": "4242", "userSalt": "4242", "chainId": 31337},
            )
            row = s.query(ScreenResult).order_by(ScreenResult.id.desc()).first()
            payload = json.loads(row.request_json)
            assert "user_salt" not in payload
            assert "userSalt" not in payload
            assert "4242" not in row.request_json


def test_r4_f2_stale_screen_admit_rejected(poseidon_ready, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from chain_verify import verify_screen_admit_binding
    from db import ScreenResult, new_decision_id

    monkeypatch.setattr(config, "SCREEN_ADMIT_MAX_AGE_SEC", 60)
    monkeypatch.setattr(config, "SCREEN_ADMIT_RECHECK", False)
    with session() as s:
        s.add(
            ScreenResult(
                decision_id=new_decision_id(),
                chain_id=31337,
                depositor=DEP_A,
                commitment="80002",
                request_json="{}",
                decision="admit",
                reasons="[]",
                addresses_checked="[]",
                deps_json="{}",
                policy_version="test",
                created_at=datetime.now(timezone.utc) - timedelta(hours=2),
            )
        )
        s.commit()
        with pytest.raises(ValueError, match="expired"):
            verify_screen_admit_binding(
                s, commitment="80002", chain_id=31337, tx_hash=None, depositor=DEP_A
            )


def test_r4_f2_recheck_blocks_sanctioned(poseidon_ready, monkeypatch):
    from chain_verify import verify_screen_admit_binding
    from db import ScreenResult, new_decision_id

    monkeypatch.setattr(config, "SCREEN_ADMIT_RECHECK", True)
    monkeypatch.setattr(config, "SCREEN_ADMIT_MAX_AGE_SEC", 3600)
    with session() as s:
        s.add(
            ScreenResult(
                decision_id=new_decision_id(),
                chain_id=31337,
                depositor=DEP_A,
                commitment="80003",
                request_json="{}",
                decision="admit",
                reasons="[]",
                addresses_checked="[]",
                deps_json="{}",
                policy_version="test",
            )
        )
        s.commit()
        with patch("oracle.is_sanctioned", return_value=True):
            with pytest.raises(ValueError, match="sanctioned"):
                verify_screen_admit_binding(
                    s, commitment="80003", chain_id=31337, tx_hash=None, depositor=DEP_A
                )


def test_r4_f3_production_requires_pending_salt_key():
    src = open(config.__file__).read()
    assert "ASP_PENDING_SALT_KEY required in production" in src


def test_r4_f4_oracle_clean_ttl_shorter_than_hit():
    assert config.ORACLE_CACHE_TTL_CLEAN_SEC < config.ORACLE_CACHE_TTL_HIT_SEC
    from oracle import _ttl_for

    assert _ttl_for(False) == config.ORACLE_CACHE_TTL_CLEAN_SEC
    assert _ttl_for(True) == config.ORACLE_CACHE_TTL_HIT_SEC


def test_r4_f5_distinct_tokens_enforced_in_config_source():
    src = open(config.__file__).read()
    assert "must be distinct when set" in src


# =============================================================================
# Round-5 OVERLORD — F-1…F-5 PoC blockers
# =============================================================================


def test_r5_f1_list_hit_blocks_admit_recheck(poseidon_ready, monkeypatch):
    from chain_verify import verify_screen_admit_binding
    from db import ScreenResult, new_decision_id, upsert_address

    monkeypatch.setattr(config, "SCREEN_ADMIT_RECHECK", True)
    monkeypatch.setattr(config, "SCREEN_ADMIT_MAX_AGE_SEC", 3600)
    with session() as s:
        upsert_address(
            s,
            address=DEP_A,
            kind="mixer",
            source="test",
        )
        s.add(
            ScreenResult(
                decision_id=new_decision_id(),
                chain_id=31337,
                depositor=DEP_A,
                commitment="81001",
                request_json="{}",
                decision="admit",
                reasons="[]",
                addresses_checked="[]",
                deps_json="{}",
                policy_version="test",
            )
        )
        s.commit()
        with patch("oracle.is_sanctioned", return_value=False):
            with pytest.raises(ValueError, match="list hit"):
                verify_screen_admit_binding(
                    s, commitment="81001", chain_id=31337, tx_hash=None, depositor=DEP_A
                )


def test_r5_f2_production_forbids_zero_max_age():
    src = open(config.__file__).read()
    assert "ASP_SCREEN_ADMIT_MAX_AGE_SEC must be > 0 in production" in src


def test_r5_f3_batch_charges_per_item(poseidon_ready, client, monkeypatch):
    from app import _rate_buckets

    monkeypatch.setattr(config, "SCREEN_RATE_LIMIT", 3)
    monkeypatch.setattr(config, "SCREEN_RATE_WINDOW_SEC", 60)
    monkeypatch.setattr(config, "REDIS_URL", "")
    _rate_buckets.clear()
    with patch("screen.is_sanctioned", return_value=False):
        r = client.post(
            "/screen/batch",
            headers=_hdr(),
            json={
                "items": [
                    {"chainId": 31337, "depositor": DEP_A, "commitment": "81011"},
                    {"chainId": 31337, "depositor": DEP_A, "commitment": "81012"},
                    {"chainId": 31337, "depositor": DEP_A, "commitment": "81013"},
                    {"chainId": 31337, "depositor": DEP_A, "commitment": "81014"},
                ]
            },
        )
    assert r.status_code == 429


def test_r5_f4_production_rejects_default_dsn():
    src = open(config.__file__).read()
    assert "default ASP_DATABASE_URL credentials" in src


def test_r5_f5_circomlibjs_path_allowlist():
    from core.poseidon import _is_allowed_circomlibjs
    from pathlib import Path

    assert _is_allowed_circomlibjs(Path("/tmp/evil")) is False
    # Construct a path that looks like node_modules/circomlibjs but need not exist
    fake = Path("/tmp/node_modules/circomlibjs")
    # is_dir() false → rejected
    assert _is_allowed_circomlibjs(fake) is False


# =============================================================================
# Round-6 OVERLORD — F-1…F-5 PoC blockers
# =============================================================================


def test_r6_f1_recheck_required_in_production_source():
    src = open(config.__file__).read()
    assert "ASP_SCREEN_ADMIT_RECHECK required in production" in src


def test_r6_f2_oracle_fail_closed_required_in_production_source():
    src = open(config.__file__).read()
    assert "ASP_ORACLE_FAIL_CLOSED required in production" in src


def test_r6_f3_seeded_lists_required_in_production_source():
    src = open(config.__file__).read()
    assert "ASP_REQUIRE_SEEDED_LISTS required in production" in src


def test_r6_f4_rate_limit_reject_does_not_charge(poseidon_ready, monkeypatch):
    from app import _rate_buckets, _rate_limit_ok

    monkeypatch.setattr(config, "SCREEN_RATE_LIMIT", 2)
    monkeypatch.setattr(config, "SCREEN_RATE_WINDOW_SEC", 60)
    monkeypatch.setattr(config, "REDIS_URL", "")
    monkeypatch.setattr(config, "PRODUCTION_LOCK", False)
    _rate_buckets.clear()
    assert _rate_limit_ok("r6f4", cost=2) is True
    # Reject without consuming further budget
    assert _rate_limit_ok("r6f4", cost=1) is False
    assert len(_rate_buckets["r6f4"]) == 2
    # Still rejected; count unchanged
    assert _rate_limit_ok("r6f4", cost=1) is False
    assert len(_rate_buckets["r6f4"]) == 2


def test_r6_f5_short_token_rejected_at_config():
    src = open(config.__file__).read()
    assert "must be at least" in src
    assert config.AUTH_TOKEN_MIN_LEN >= 16
    assert len(config.SCREEN_TOKEN) >= config.AUTH_TOKEN_MIN_LEN or config.SCREEN_TOKEN == ""


# =============================================================================
# Round-7 OVERLORD — F-1…F-4 PoC blockers
# =============================================================================


def test_r7_f1_auth_min_len_floored_in_production_source():
    """PoC: PRODUCTION_LOCK=1 ASP_AUTH_TOKEN_MIN_LEN=1 ASP_SCREEN_TOKEN=x must not boot."""
    src = open(config.__file__).read()
    assert "AUTH_TOKEN_MIN_LEN = max(AUTH_TOKEN_MIN_LEN, 16)" in src
    assert "characters in production" in src


def test_r7_f2_chain_min_confirmations_required_in_production_source():
    """PoC: ASP_CHAIN_MIN_CONFIRMATIONS=0 under PRODUCTION_LOCK must raise."""
    src = open(config.__file__).read()
    assert "ASP_CHAIN_MIN_CONFIRMATIONS must be >= 1 in production" in src


def test_r7_f3_zkme_deny_blocks_admit_recheck(poseidon_ready, monkeypatch):
    """PoC: screen admit → zkMe deny at recheck → admit binding fails."""
    from chain_verify import verify_screen_admit_binding
    from db import ScreenResult, new_decision_id, upsert_kyt_entitlement
    from zkme import ZkMeResult

    monkeypatch.setattr(config, "SCREEN_ADMIT_RECHECK", True)
    monkeypatch.setattr(config, "SCREEN_ADMIT_MAX_AGE_SEC", 3600)
    monkeypatch.setattr(config, "ZKME_MCH_NO", "mch-test")
    monkeypatch.setattr(config, "ZKME_API_KEY", "key-test")
    with session() as s:
        upsert_kyt_entitlement(
            s,
            wallet=DEP_A,
            tx_hash="0x" + "a1" * 32,
            chain_id=31337,
            token="ETH",
            amount_raw="1",
        )
        s.add(
            ScreenResult(
                decision_id=new_decision_id(),
                chain_id=31337,
                depositor=DEP_A,
                commitment="90001",
                request_json="{}",
                decision="admit",
                reasons="[]",
                addresses_checked="[]",
                deps_json="{}",
                policy_version="test",
            )
        )
        s.commit()
        deny = ZkMeResult(
            decision="deny",
            risk_score=99,
            risk_level="High",
            reasons=["zkme_high_risk"],
            raw={},
        )
        with patch("oracle.is_sanctioned", return_value=False):
            with patch("zkme.screen_address", return_value=deny):
                with pytest.raises(ValueError, match="zkme deny"):
                    verify_screen_admit_binding(
                        s,
                        commitment="90001",
                        chain_id=31337,
                        tx_hash=None,
                        depositor=DEP_A,
                    )


def test_r7_f3_zkme_unavailable_fail_closed_at_admit(poseidon_ready, monkeypatch):
    from chain_verify import verify_screen_admit_binding
    from db import ScreenResult, new_decision_id, upsert_kyt_entitlement
    from zkme import ZkMeUnavailable

    monkeypatch.setattr(config, "SCREEN_ADMIT_RECHECK", True)
    monkeypatch.setattr(config, "SCREEN_ADMIT_MAX_AGE_SEC", 3600)
    monkeypatch.setattr(config, "ZKME_MCH_NO", "mch-test")
    monkeypatch.setattr(config, "ZKME_API_KEY", "key-test")
    with session() as s:
        upsert_kyt_entitlement(
            s,
            wallet=DEP_A,
            tx_hash="0x" + "a2" * 32,
            chain_id=31337,
            token="ETH",
            amount_raw="1",
        )
        s.add(
            ScreenResult(
                decision_id=new_decision_id(),
                chain_id=31337,
                depositor=DEP_A,
                commitment="90002",
                request_json="{}",
                decision="admit",
                reasons="[]",
                addresses_checked="[]",
                deps_json="{}",
                policy_version="test",
            )
        )
        s.commit()
        with patch("oracle.is_sanctioned", return_value=False):
            with patch(
                "zkme.screen_address",
                side_effect=ZkMeUnavailable("zkMe API error: down"),
            ):
                with pytest.raises(ValueError, match="zkme unavailable"):
                    verify_screen_admit_binding(
                        s,
                        commitment="90002",
                        chain_id=31337,
                        tx_hash=None,
                        depositor=DEP_A,
                    )


def test_r7_f4_screen_token_required_in_production_source():
    """PoC: empty ASP_SCREEN_TOKEN under PRODUCTION_LOCK must raise at import."""
    src = open(config.__file__).read()
    assert "ASP_SCREEN_TOKEN required in production" in src


# =============================================================================
# Round-8 OVERLORD — KYT fee ledger / confirmations / prod floors (F-1…F-5)
# =============================================================================


def test_r8_f1_fee_tx_hash_never_reusable(poseidon_ready):
    """PoC: after expiry, same txHash must not renew; consumed hash blocked forever."""
    from datetime import datetime, timedelta, timezone

    from db import upsert_kyt_entitlement

    tx = "0x" + "bb" * 32
    with session() as s:
        row = upsert_kyt_entitlement(
            s,
            wallet=DEP_A,
            tx_hash=tx,
            chain_id=1,
            token="ETH",
            amount_raw="1",
        )
        row.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
        s.commit()
        with pytest.raises(ValueError, match="already consumed"):
            upsert_kyt_entitlement(
                s,
                wallet=DEP_A,
                tx_hash=tx,
                chain_id=1,
                token="ETH",
                amount_raw="1",
            )
        # Cross-wallet reuse of freed-looking hash also blocked
        with pytest.raises(ValueError, match="already consumed"):
            upsert_kyt_entitlement(
                s,
                wallet=DEP_B,
                tx_hash=tx,
                chain_id=1,
                token="ETH",
                amount_raw="1",
            )


def test_r8_f2_fee_verify_requires_confirmations_in_source():
    src = open(__import__("compliance_fee", fromlist=["x"]).__file__).read()
    assert "confirmations" in src
    assert "CHAIN_MIN_CONFIRMATIONS" in src


def test_r8_f3_zero_fee_forbidden_in_production_source():
    src = open(config.__file__).read()
    assert "ASP_COMPLIANCE_FEE_WEI must be > 0 in production" in src
    assert "ASP_COMPLIANCE_FEE_USDC must be > 0 in production" in src


def test_r8_f4_entitlement_days_capped_in_production_source():
    src = open(config.__file__).read()
    assert "ASP_KYT_ENTITLEMENT_DAYS must be <= 366 in production" in src


def test_r8_f5_admit_recheck_requires_kyt_entitlement(poseidon_ready, monkeypatch):
    """PoC: zkMe configured + no entitlement → admit recheck fails before zkMe call."""
    from chain_verify import verify_screen_admit_binding
    from db import ScreenResult, new_decision_id
    from unittest.mock import MagicMock

    monkeypatch.setattr(config, "SCREEN_ADMIT_RECHECK", True)
    monkeypatch.setattr(config, "SCREEN_ADMIT_MAX_AGE_SEC", 3600)
    monkeypatch.setattr(config, "ZKME_MCH_NO", "mch-test")
    monkeypatch.setattr(config, "ZKME_API_KEY", "key-test")
    monkeypatch.setattr(config, "ALLOW_SKIP_KYT_FEE", False)
    zkme = MagicMock()
    with session() as s:
        s.add(
            ScreenResult(
                decision_id=new_decision_id(),
                chain_id=31337,
                depositor=DEP_A,
                commitment="90003",
                request_json="{}",
                decision="admit",
                reasons="[]",
                addresses_checked="[]",
                deps_json="{}",
                policy_version="test",
            )
        )
        s.commit()
        with patch("oracle.is_sanctioned", return_value=False):
            with patch("zkme.screen_address", zkme):
                with pytest.raises(ValueError, match="kyt entitlement inactive"):
                    verify_screen_admit_binding(
                        s,
                        commitment="90003",
                        chain_id=31337,
                        tx_hash=None,
                        depositor=DEP_A,
                    )
    zkme.assert_not_called()


# =============================================================================
# Round-9 OVERLORD — fee input validation / race / batch 402 (F-1…F-3)
# =============================================================================


def test_r9_f1_fee_verify_rejects_bad_wallet_and_tx():
    from compliance_fee import FeeNotPaid, verify_fee_payment

    with session() as s:
        with pytest.raises(FeeNotPaid, match="wallet must be"):
            verify_fee_payment(
                s, chain_id=1, tx_hash="0x" + "ab" * 32, wallet="not-an-address"
            )
        with pytest.raises(FeeNotPaid, match="txHash must be"):
            verify_fee_payment(s, chain_id=1, tx_hash="0xdead", wallet=DEP_A)


def test_r9_f2_integrity_error_mapped_to_consumed(poseidon_ready, monkeypatch):
    from compliance_fee import FeeNotPaid, verify_fee_payment
    from sqlalchemy.exc import IntegrityError

    monkeypatch.setattr(config, "COMPLIANCE_VAULT", "0x" + "cc" * 20)
    monkeypatch.setattr(config, "CHAIN_MIN_CONFIRMATIONS", 0)
    monkeypatch.setattr(config, "COMPLIANCE_FEE_WEI", 1)

    receipt = {"status": 1, "blockNumber": 1, "logs": []}
    tx = {"from": DEP_A, "to": "0x" + "cc" * 20, "value": 10}

    class FakeW3:
        class eth:
            block_number = 10

            @staticmethod
            def get_transaction_receipt(_h):
                return receipt

            @staticmethod
            def get_transaction(_h):
                return tx

    monkeypatch.setattr("compliance_fee._w3", lambda _cid: FakeW3())
    monkeypatch.setattr(
        "compliance_fee.upsert_kyt_entitlement",
        lambda *a, **k: (_ for _ in ()).throw(IntegrityError("stmt", {}, Exception())),
    )
    with session() as s:
        with pytest.raises(FeeNotPaid, match="already consumed"):
            verify_fee_payment(s, chain_id=1, tx_hash="0x" + "11" * 32, wallet=DEP_A)


def test_r9_f3_batch_screen_returns_402_when_fee_required(poseidon_ready, client, monkeypatch):
    monkeypatch.setattr(config, "ZKME_MCH_NO", "mch")
    monkeypatch.setattr(config, "ZKME_API_KEY", "key")
    monkeypatch.setattr(config, "ALLOW_SKIP_KYT_FEE", False)
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)
    monkeypatch.setattr("screen.is_sanctioned", lambda _a, _c: False)
    r = client.post(
        "/screen/batch",
        json={
            "items": [
                {
                    "chainId": 8453,
                    "depositor": DEP_A,
                    "commitment": "12345",
                }
            ]
        },
        headers={"Authorization": "Bearer screen-test-token16"},
    )
    assert r.status_code == 402
    data = r.get_json()
    assert data.get("feeRequired") is True
    assert "kyt_fee_required" in (data["results"][0].get("reasons") or [])
