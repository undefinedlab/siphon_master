"""Rule 1/2 selection + amount-based /set/revoke."""
from __future__ import annotations

import os

import pytest

os.environ["ASP_DATABASE_URL"] = "sqlite:///:memory:"
os.environ["ASP_SCREEN_TOKEN"] = "screen-test-token16"
os.environ["ASP_POSTMAN_TOKEN"] = "postman-test-tok16"
os.environ["ASP_REQUIRE_AUTH"] = "1"
os.environ["ASP_AUTO_PUBLISH_ROOT"] = "0"
os.environ["ASP_REQUIRE_SEEDED_LISTS"] = "0"

import config
import db
from app import app
from association_set import admit_label
from db import AspLabel, init_db, session
from revocation_set import is_revoked, revoke_label
from rule_one_two import (
    POLICY_EXACT,
    POLICY_NONE,
    POLICY_SMALLEST_FIT,
    POLICY_SOURCE_LABEL,
    canonical_amount,
    canonical_asset_id,
    live_labels,
    select_labels_to_freeze,
)

DEPOSITOR = "0x2222222222222222222222222222222222222222"
OTHER_DEPOSITOR = "0x3333333333333333333333333333333333333333"
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
USDC_ID = str(int(USDC, 16))
WETH_ID = str(int(WETH, 16))


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)
    monkeypatch.setattr(config, "AUTO_PUBLISH_ROOT", False)
    monkeypatch.setattr(config, "SCREEN_TOKEN", "screen-test-token16")
    monkeypatch.setattr(config, "POSTMAN_TOKEN", "postman-test-tok16")
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


@pytest.fixture
def client():
    return app.test_client()


def _headers() -> dict:
    return {
        "Authorization": "Bearer postman-test-tok16",
        "Content-Type": "application/json",
    }


def _seed(dbs, label: int, amount: int, *, depositor=DEPOSITOR, asset_id=USDC_ID):
    admit_label(
        dbs,
        label=str(label),
        chain_id=11155111,
        depositor=depositor,
        amount=str(amount),
        asset_id=asset_id,
    )


# ---------------------------------------------------------------- normalizers


def test_canonical_amount_accepts_decimal_and_hex():
    assert canonical_amount("100") == 100
    assert canonical_amount(100) == 100
    assert canonical_amount("0x64") == 100


def test_canonical_amount_rejects_negative_and_garbage():
    with pytest.raises(ValueError):
        canonical_amount("-1")
    with pytest.raises(ValueError):
        canonical_amount("abc")
    with pytest.raises(ValueError):
        canonical_amount("")


def test_canonical_asset_id_from_address_and_decimal():
    assert canonical_asset_id(USDC) == USDC_ID
    assert canonical_asset_id(USDC_ID) == USDC_ID


def test_canonical_asset_id_rejects_oversized():
    with pytest.raises(ValueError):
        canonical_asset_id(str(1 << 160))


# ------------------------------------------------------------------- Rule 1


def test_rule_one_exact_match(poseidon_ready):
    with session() as dbs:
        _seed(dbs, 1001, 500)
        _seed(dbs, 1002, 100)
        _seed(dbs, 1003, 900)
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs, depositor=DEPOSITOR, amount_x=100, asset_id=USDC_ID
        )
    assert sel.policy == POLICY_EXACT
    assert sel.labels == ["1002"]
    assert sel.covered == 100
    assert sel.sufficient is True
    assert sel.shortfall == 0


def test_rule_one_preferred_over_smaller_fitting_label(poseidon_ready):
    """An exact match wins even when a larger label would also fit."""
    with session() as dbs:
        _seed(dbs, 2001, 700)
        _seed(dbs, 2002, 500)
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs, depositor=DEPOSITOR, amount_x=500, asset_id=USDC_ID
        )
    assert sel.policy == POLICY_EXACT
    assert sel.labels == ["2002"]


# ------------------------------------------------------------------- Rule 2


def test_rule_two_smallest_fit(poseidon_ready):
    """Smallest label >= X, not the largest — over-freeze the least."""
    with session() as dbs:
        _seed(dbs, 3001, 900)
        _seed(dbs, 3002, 400)
        _seed(dbs, 3003, 600)
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs, depositor=DEPOSITOR, amount_x=500, asset_id=USDC_ID
        )
    assert sel.policy == POLICY_SMALLEST_FIT
    assert sel.labels == ["3003"]
    assert sel.covered == 600
    assert sel.sufficient is True


def test_rule_two_ties_break_on_leaf_index(poseidon_ready):
    with session() as dbs:
        _seed(dbs, 4002, 600)
        _seed(dbs, 4001, 600)
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs, depositor=DEPOSITOR, amount_x=500, asset_id=USDC_ID
        )
    # 4002 was admitted first -> lower leaf_index -> deterministic winner.
    assert sel.labels == ["4002"]


# ---------------------------------------------------- no greedy multi-label


def test_no_greedy_sweep_when_only_sum_covers(poseidon_ready):
    """[3,3,4] with X=6: sum covers but no single label does -> no fit."""
    with session() as dbs:
        _seed(dbs, 5001, 3)
        _seed(dbs, 5002, 3)
        _seed(dbs, 5003, 4)
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs, depositor=DEPOSITOR, amount_x=6, asset_id=USDC_ID
        )
    assert sel.policy == POLICY_NONE
    assert sel.labels == []
    assert sel.sufficient is False
    assert sel.covered == 0
    assert sel.shortfall == 6
    assert len(sel.candidates) == 3


# ------------------------------------------------------- source (checked first)


def test_source_rule_freezes_live_flagged_label(poseidon_ready):
    """The flagged label is live -> freeze the source, whatever its value."""
    with session() as dbs:
        _seed(dbs, 6001, 10)  # the flagged deposit, below X
        _seed(dbs, 6002, 20)
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs,
            depositor=DEPOSITOR,
            amount_x=999,
            asset_id=USDC_ID,
            flagged_label="6001",
        )
    assert sel.policy == POLICY_SOURCE_LABEL
    assert sel.labels == ["6001"]
    # Freezing the source blocks every child that inherited the label.
    assert sel.sufficient is True


def test_source_rule_skipped_when_already_revoked(poseidon_ready):
    with session() as dbs:
        _seed(dbs, 7001, 10)
        revoke_label(dbs, label="7001", reason="test")
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs,
            depositor=DEPOSITOR,
            amount_x=999,
            asset_id=USDC_ID,
            flagged_label="7001",
        )
    assert sel.policy == POLICY_NONE
    assert sel.labels == []
    assert sel.sufficient is False


def test_live_source_preempts_rules_one_and_two(poseidon_ready):
    """Source first: a live flagged label wins over any fungible substitute.

    Freezing a clean label while the actual bad label stays spendable would be
    strictly worse, so the source is revoked irrespective of its value.
    """
    with session() as dbs:
        _seed(dbs, 8001, 10)  # the flagged label, well below X
        _seed(dbs, 8002, 100)  # an exact match for X
        _seed(dbs, 8003, 500)  # a smallest-fit candidate
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs,
            depositor=DEPOSITOR,
            amount_x=100,
            asset_id=USDC_ID,
            flagged_label="8001",
        )
    assert sel.policy == POLICY_SOURCE_LABEL
    assert sel.labels == ["8001"]
    assert sel.sufficient is True


def test_rules_one_two_apply_when_no_flagged_label_given(poseidon_ready):
    """Without a flagged label the fungible rules are the whole policy."""
    with session() as dbs:
        _seed(dbs, 8101, 10)
        _seed(dbs, 8102, 100)
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs, depositor=DEPOSITOR, amount_x=100, asset_id=USDC_ID
        )
    assert sel.policy == POLICY_EXACT
    assert sel.labels == ["8102"]


def test_rules_one_two_apply_when_flagged_label_dead(poseidon_ready):
    """A revoked/absent source falls through to the fungible rules."""
    with session() as dbs:
        _seed(dbs, 8201, 10)
        _seed(dbs, 8202, 100)
        revoke_label(dbs, label="8201", reason="test")
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs,
            depositor=DEPOSITOR,
            amount_x=100,
            asset_id=USDC_ID,
            flagged_label="8201",
        )
    assert sel.policy == POLICY_EXACT
    assert sel.labels == ["8202"]


def test_source_rule_rejects_cross_depositor_flagged_label(poseidon_ready):
    """A flagged label belonging to someone else must not be freezable."""
    with session() as dbs:
        _seed(dbs, 9001, 10, depositor=OTHER_DEPOSITOR)
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs,
            depositor=DEPOSITOR,
            amount_x=999,
            asset_id=USDC_ID,
            flagged_label="9001",
        )
    assert sel.policy == POLICY_NONE
    assert sel.labels == []


# ------------------------------------------------------- liveness / scoping


def test_revoked_labels_excluded(poseidon_ready):
    with session() as dbs:
        _seed(dbs, 10001, 500)
        _seed(dbs, 10002, 500)
        revoke_label(dbs, label="10001", reason="test")
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs, depositor=DEPOSITOR, amount_x=500, asset_id=USDC_ID
        )
    assert sel.labels == ["10002"]


def test_wrong_asset_excluded(poseidon_ready):
    """D1: a USDC freeze never touches a WETH label."""
    with session() as dbs:
        _seed(dbs, 11001, 500, asset_id=WETH_ID)
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs, depositor=DEPOSITOR, amount_x=500, asset_id=USDC_ID
        )
    assert sel.labels == []
    assert sel.sufficient is False
    assert sel.candidates == []


def test_other_depositor_excluded(poseidon_ready):
    with session() as dbs:
        _seed(dbs, 12001, 500, depositor=OTHER_DEPOSITOR)
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs, depositor=DEPOSITOR, amount_x=500, asset_id=USDC_ID
        )
    assert sel.labels == []


def test_null_amount_rows_excluded(poseidon_ready):
    """Rows predating the Rule 1/2 columns have unknown value -> not freezable."""
    with session() as dbs:
        admit_label(dbs, label="13001", chain_id=11155111, depositor=DEPOSITOR)
        dbs.commit()

        cands = live_labels(dbs, depositor=DEPOSITOR, asset_id=USDC_ID)
    assert cands == []


def test_depositor_match_is_case_insensitive(poseidon_ready):
    with session() as dbs:
        _seed(dbs, 14001, 500)
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs, depositor=DEPOSITOR.upper(), amount_x=500, asset_id=USDC_ID
        )
    assert sel.labels == ["14001"]


def test_queued_labels_are_selectable(poseidon_ready):
    """Admit-epoch: a queued label is in the tree, so it must be freezable."""
    with session() as dbs:
        _seed(dbs, 15001, 500)
        row = dbs.query(AspLabel).filter(AspLabel.label == "15001").one()
        assert row.status == "queued"
        dbs.commit()

        sel = select_labels_to_freeze(
            dbs, depositor=DEPOSITOR, amount_x=500, asset_id=USDC_ID
        )
    assert sel.labels == ["15001"]


def test_empty_pool_reports_shortfall(poseidon_ready):
    with session() as dbs:
        sel = select_labels_to_freeze(
            dbs, depositor=DEPOSITOR, amount_x=500, asset_id=USDC_ID
        )
    assert sel.sufficient is False
    assert sel.shortfall == 500
    assert sel.candidates == []


# ----------------------------------------------------------------- schema


def test_asp_label_has_rule_one_two_columns(poseidon_ready):
    with session() as dbs:
        _seed(dbs, 16001, 4200, asset_id=USDC_ID)
        dbs.commit()
        row = dbs.query(AspLabel).filter(AspLabel.label == "16001").one()
    assert row.amount == "4200"
    assert row.asset_id == USDC_ID


# ------------------------------------------------------------------ route


def test_route_selects_and_revokes(poseidon_ready, client):
    with session() as dbs:
        _seed(dbs, 17001, 900)
        _seed(dbs, 17002, 600)
        dbs.commit()

    r = client.post(
        "/set/revoke",
        headers=_headers(),
        json={"depositor": DEPOSITOR, "amount": "500", "assetId": USDC, "chainId": 11155111},
    )
    assert r.status_code == 200
    data = r.get_json()
    assert data["revoked"] is True
    assert data["mode"] == "rule_1_2"
    assert data["policy"] == POLICY_SMALLEST_FIT
    assert data["labels"] == ["17002"]
    assert data["sufficient"] is True

    with session() as dbs:
        assert is_revoked(dbs, "17002")
        assert not is_revoked(dbs, "17001")


def test_route_reports_no_fit_as_200(poseidon_ready, client):
    with session() as dbs:
        _seed(dbs, 18001, 3)
        _seed(dbs, 18002, 4)
        dbs.commit()

    r = client.post(
        "/set/revoke",
        headers=_headers(),
        json={"depositor": DEPOSITOR, "amount": "500", "assetId": USDC},
    )
    assert r.status_code == 200
    data = r.get_json()
    assert data["revoked"] is False
    assert data["sufficient"] is False
    assert data["labels"] == []
    assert data["shortfall"] == "500"
    assert len(data["candidates"]) == 2

    with session() as dbs:
        assert not is_revoked(dbs, "18001")
        assert not is_revoked(dbs, "18002")


def test_route_source_rule_via_flagged_label(poseidon_ready, client):
    with session() as dbs:
        _seed(dbs, 19001, 10)
        dbs.commit()

    r = client.post(
        "/set/revoke",
        headers=_headers(),
        json={
            "depositor": DEPOSITOR,
            "amount": "999",
            "assetId": USDC,
            "flaggedLabel": "19001",
        },
    )
    assert r.status_code == 200
    data = r.get_json()
    assert data["policy"] == POLICY_SOURCE_LABEL
    assert data["labels"] == ["19001"]

    with session() as dbs:
        assert is_revoked(dbs, "19001")


def test_route_requires_depositor(poseidon_ready, client):
    r = client.post(
        "/set/revoke",
        headers=_headers(),
        json={"amount": "500", "assetId": USDC},
    )
    assert r.status_code == 400
    assert "depositor" in r.get_json()["error"]


def test_route_requires_asset_id(poseidon_ready, client):
    r = client.post(
        "/set/revoke",
        headers=_headers(),
        json={"depositor": DEPOSITOR, "amount": "500"},
    )
    assert r.status_code == 400
    assert "assetId" in r.get_json()["error"]


def test_route_rejects_bad_amount(poseidon_ready, client):
    r = client.post(
        "/set/revoke",
        headers=_headers(),
        json={"depositor": DEPOSITOR, "amount": "not-a-number", "assetId": USDC},
    )
    assert r.status_code == 400


def test_route_requires_auth(poseidon_ready, client):
    r = client.post(
        "/set/revoke",
        headers={"Content-Type": "application/json"},
        json={"depositor": DEPOSITOR, "amount": "500", "assetId": USDC},
    )
    assert r.status_code == 401


def test_explicit_label_path_still_works(poseidon_ready, client):
    """Backward compatibility: {label} revoke is unchanged."""
    with session() as dbs:
        _seed(dbs, 20001, 500)
        dbs.commit()

    r = client.post("/set/revoke", headers=_headers(), json={"label": "20001"})
    assert r.status_code == 200
    assert r.get_json()["revoked"] is True

    with session() as dbs:
        assert is_revoked(dbs, "20001")


def test_label_missing_without_amount_still_400(poseidon_ready, client):
    r = client.post("/set/revoke", headers=_headers(), json={})
    assert r.status_code == 400
    assert r.get_json()["error"] == "label required"


def test_amount_branch_cannot_pollute_smt_with_unadmitted_label(poseidon_ready, client):
    """F-4: selection reads labels out of asp_label, so an unadmitted label can
    never enter the SMT through the amount branch — even if the caller names it."""
    r = client.post(
        "/set/revoke",
        headers=_headers(),
        json={
            "depositor": DEPOSITOR,
            "amount": "500",
            "assetId": USDC,
            "flaggedLabel": "999999999",  # never admitted
        },
    )
    assert r.status_code == 200
    assert r.get_json()["labels"] == []

    with session() as dbs:
        assert not is_revoked(dbs, "999999999")
