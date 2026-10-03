"""KYT entitlement + layer1-before-zkMe screening."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

os.environ.setdefault("ASP_REQUIRE_AUTH", "0")
os.environ.setdefault("ASP_REQUIRE_SEEDED_LISTS", "0")
os.environ.setdefault("ASP_DATABASE_URL", "sqlite:///:memory:")

import config
import db
from db import init_db, session, upsert_address, upsert_kyt_entitlement
from screen import screen
from zkme import ZkMeResult


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)
    monkeypatch.setattr(config, "ALLOW_SKIP_KYT_FEE", False)
    monkeypatch.setattr(config, "ZKME_MCH_NO", "")
    monkeypatch.setattr(config, "ZKME_API_KEY", "")
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


DEP = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


def test_layer1_mixer_does_not_call_zkme(monkeypatch):
    monkeypatch.setattr(config, "ZKME_MCH_NO", "mch")
    monkeypatch.setattr(config, "ZKME_API_KEY", "key")
    monkeypatch.setattr("screen.is_sanctioned", lambda _a, _c: False)
    called = MagicMock()
    monkeypatch.setattr("screen.zkme_screen", called)
    with session() as s:
        upsert_address(s, address=DEP, kind="mixer", source="test")
        s.commit()
        out = screen(s, chain_id=8453, depositor=DEP, persist=False)
    assert out.decision == "deny"
    assert "mixer" in out.reasons
    called.assert_not_called()


def test_zkme_fee_required_without_entitlement(monkeypatch):
    monkeypatch.setattr(config, "ZKME_MCH_NO", "mch")
    monkeypatch.setattr(config, "ZKME_API_KEY", "key")
    monkeypatch.setattr("screen.is_sanctioned", lambda _a, _c: False)
    called = MagicMock()
    monkeypatch.setattr("screen.zkme_screen", called)
    with session() as s:
        out = screen(s, chain_id=8453, depositor=DEP, persist=False)
    assert out.decision == "pending"
    assert "kyt_fee_required" in out.reasons
    assert out.deps.get("zkme") == "fee_required"
    called.assert_not_called()


def test_entitled_wallet_calls_zkme(monkeypatch):
    monkeypatch.setattr(config, "ZKME_MCH_NO", "mch")
    monkeypatch.setattr(config, "ZKME_API_KEY", "key")
    monkeypatch.setattr("screen.is_sanctioned", lambda _a, _c: False)
    monkeypatch.setattr(
        "screen.zkme_screen",
        lambda _a, _c: ZkMeResult(
            decision="admit", risk_score=10, risk_level="Low", reasons=[], raw={}
        ),
    )
    with session() as s:
        upsert_kyt_entitlement(
            s,
            wallet=DEP,
            tx_hash="0x" + "ab" * 32,
            chain_id=8453,
            token="ETH",
            amount_raw="200000000000000",
        )
        s.commit()
        out = screen(s, chain_id=8453, depositor=DEP, persist=False)
    assert out.decision == "admit"
    assert out.deps.get("kytEntitlement") is True
    hits = out.checked[0]["hits"]
    zk = next(h for h in hits if h.get("kind") == "zkme_kyt")
    assert zk["riskScore"] == 10
    assert zk["riskLevel"] == "Low"
    assert zk["decision"] == "admit"


def test_expired_entitlement_requires_fee(monkeypatch):
    monkeypatch.setattr(config, "ZKME_MCH_NO", "mch")
    monkeypatch.setattr(config, "ZKME_API_KEY", "key")
    monkeypatch.setattr("screen.is_sanctioned", lambda _a, _c: False)
    called = MagicMock()
    monkeypatch.setattr("screen.zkme_screen", called)
    with session() as s:
        row = upsert_kyt_entitlement(
            s,
            wallet=DEP,
            tx_hash="0x" + "cd" * 32,
            chain_id=8453,
            token="ETH",
            amount_raw="1",
        )
        row.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
        s.commit()
        out = screen(s, chain_id=8453, depositor=DEP, persist=False)
    assert "kyt_fee_required" in out.reasons
    called.assert_not_called()


def test_skip_kyt_fee_escape_calls_zkme(monkeypatch):
    monkeypatch.setattr(config, "ZKME_MCH_NO", "mch")
    monkeypatch.setattr(config, "ZKME_API_KEY", "key")
    monkeypatch.setattr(config, "ALLOW_SKIP_KYT_FEE", True)
    monkeypatch.setattr("screen.is_sanctioned", lambda _a, _c: False)
    monkeypatch.setattr(
        "screen.zkme_screen",
        lambda _a, _c: ZkMeResult(
            decision="admit", risk_score=1, risk_level="Low", reasons=[], raw={}
        ),
    )
    with session() as s:
        out = screen(s, chain_id=8453, depositor=DEP, persist=False)
    assert out.decision == "admit"


def test_entitlement_status_and_already_paid():
    from compliance_fee import FeeAlreadyPaid, entitlement_status, verify_fee_payment

    with session() as s:
        upsert_kyt_entitlement(
            s,
            wallet=DEP,
            tx_hash="0x" + "ef" * 32,
            chain_id=1,
            token="ETH",
            amount_raw="1",
        )
        s.commit()
        st = entitlement_status(s, DEP)
        assert st["paid"] is True
        assert st["active"] is True
        assert st["expiresAt"]
        assert st["product"] == "kyt_year_v1"
        with pytest.raises(FeeAlreadyPaid):
            verify_fee_payment(
                s, chain_id=1, tx_hash="0x" + "11" * 32, wallet=DEP
            )


def test_kyc_entitlement_separate_from_kyt():
    from compliance_fee import PRODUCT_KYC, PRODUCT_KYT, entitlement_status, verify_fee_payment
    from db import has_active_kyc_entitlement, has_active_kyt_entitlement, upsert_kyc_entitlement

    with session() as s:
        upsert_kyt_entitlement(
            s,
            wallet=DEP,
            tx_hash="0x" + "22" * 32,
            chain_id=8453,
            token="ETH",
            amount_raw="1",
        )
        s.commit()
        assert has_active_kyt_entitlement(s, DEP) is True
        assert has_active_kyc_entitlement(s, DEP) is False
        kyt_st = entitlement_status(s, DEP, product=PRODUCT_KYT)
        kyc_st = entitlement_status(s, DEP, product=PRODUCT_KYC)
        assert kyt_st["paid"] is True
        assert kyc_st["paid"] is False

        upsert_kyc_entitlement(
            s,
            wallet=DEP,
            tx_hash="0x" + "33" * 32,
            chain_id=8453,
            token="ETH",
            amount_raw="1",
        )
        s.commit()
        assert has_active_kyc_entitlement(s, DEP) is True
        kyc_st = entitlement_status(s, DEP, product=PRODUCT_KYC)
        assert kyc_st["paid"] is True
        assert kyc_st["product"] == PRODUCT_KYC


def test_zkme_module_has_no_cache():
    import zkme

    src = open(zkme.__file__).read()
    assert "_cache" not in src
    assert "_ttl_for" not in src
