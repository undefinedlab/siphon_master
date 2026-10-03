#!/usr/bin/env python3
"""Clock smoke: screen → admit (mocked chain) → ASP/SMT paths shaped like zkv2 SpendWitness.

Does not require Anvil. Live deposit→publish is documented in scripts/BOOTSTRAP.md.

Run: python scripts/e2e_journey.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

os.environ["ASP_DATABASE_URL"] = f"sqlite:///{ROOT / 'e2e_smoke.db'}"
os.environ["ASP_REQUIRE_AUTH"] = "0"
os.environ["ASP_AUTO_PUBLISH_ROOT"] = "0"
os.environ["ASP_REQUIRE_SEEDED_LISTS"] = "0"
# config.py floors auth tokens at AUTH_TOKEN_MIN_LEN (16). These were 10 and 11 characters, so
# this script raised at `import config` and could never run at all.
E2E_POSTMAN_TOKEN = "e2e-postman-token-0123456789"
E2E_SCREEN_TOKEN = "e2e-screen-token-0123456789"
os.environ["ASP_POSTMAN_TOKEN"] = E2E_POSTMAN_TOKEN
os.environ["ASP_SCREEN_TOKEN"] = E2E_SCREEN_TOKEN

import config
import db
from app import app
from core.label import derive_deposit_label
from db import init_db, session
from screen import screen

# Match siphon-contracts-v2/fixtures/zkv2/test-vectors/deposit-ok.json shape.
#
# CHAIN_ID was hardcoded to 84532 (Base Sepolia). The label is derived from the chain id
# (PROTOCOL §A.1: vaultScopeId = Poseidon(DOMAIN_CHAIN_EVM, chainId, vault)), so running this
# against any other deployment produced labels the ASP would never match — a green e2e that
# proved nothing about the chain you actually deployed to. Override with E2E_CHAIN_ID.
CHAIN_ID = int(os.environ.get("E2E_CHAIN_ID", "84532"))
VAULT = os.environ.get("E2E_VAULT", "0x" + "a1" * 20)
DEPOSIT_NONCE = int(os.environ.get("E2E_DEPOSIT_NONCE", "7"))
USER_SALT = int(os.environ.get("E2E_USER_SALT", "4242"))
COMMITMENT = os.environ.get("E2E_COMMITMENT", "123456789")
DEPOSITOR = os.environ.get("E2E_DEPOSITOR", "0x2222222222222222222222222222222222222222")


def main() -> int:
    config.POSTMAN_TOKEN = E2E_POSTMAN_TOKEN
    config.SCREEN_TOKEN = E2E_SCREEN_TOKEN
    config.AUTO_PUBLISH_ROOT = False
    db._engine = None
    db.SessionLocal = None
    init_db()

    label = str(
        derive_deposit_label(
            chain_id=CHAIN_ID,
            vault_address=VAULT,
            deposit_nonce=DEPOSIT_NONCE,
            user_salt=USER_SALT,
        )
    )

    client = app.test_client()
    screen_hdr = {"Authorization": f"Bearer {E2E_SCREEN_TOKEN}"}
    postman_hdr = {"Authorization": f"Bearer {E2E_POSTMAN_TOKEN}", "Content-Type": "application/json"}

    with patch("screen.is_sanctioned", return_value=False):
        with session() as s:
            out = screen(
                s,
                chain_id=CHAIN_ID,
                depositor=DEPOSITOR,
                commitment=COMMITMENT,
                persist=True,
            )
    assert out.decision == "admit", out.to_dict()

    dep_mock = {
        "depositor": DEPOSITOR,
        "commitment": COMMITMENT,
        "depositNonce": DEPOSIT_NONCE,
        "amount": "1000",
        "stateRootAfter": "1",
        "vault": VAULT,
        "chainId": CHAIN_ID,
    }
    with patch("app.verify_deposited", return_value=dep_mock):
        admit_r = client.post(
            "/set/admit",
            headers=postman_hdr,
            json={
                "label": label,
                "txHash": "0x" + "ab" * 32,
                "vault": VAULT,
                "chainId": CHAIN_ID,
                "commitment": COMMITMENT,
                "userSalt": str(USER_SALT),
            },
            content_type="application/json",
        )
    assert admit_r.status_code == 200, admit_r.get_data(as_text=True)

    root_r = client.get("/set/root", headers=screen_hdr)
    assert root_r.status_code == 200, root_r.get_data(as_text=True)
    roots = root_r.get_json()
    assert roots["admittedRoot"] and roots["revokedRoot"]
    assert roots["admittedLeafCount"] >= 1

    path_r = client.get(f"/set/path?label={label}", headers=screen_hdr)
    assert path_r.status_code == 200, path_r.get_data(as_text=True)
    path = path_r.get_json()
    assert len(path["pathElements"]) == 32
    assert len(path["pathIndices"]) == 32
    assert path["admittedRoot"] == roots["admittedRoot"]

    smt_r = client.get(f"/set/smt-path?label={label}", headers=screen_hdr)
    assert smt_r.status_code == 200, smt_r.get_data(as_text=True)
    smt = smt_r.get_json()
    assert len(smt["pathElements"]) == 32
    assert "claimedLeaf" in smt
    # Circom revokedSmtLeaf = claimedLeaf (slot value); empty SMT → "0"
    assert smt["claimedLeaf"] == "0" or int(smt["claimedLeaf"]) >= 0
    assert smt["revokedRoot"] == roots["revokedRoot"]

    # Shape check vs PROTOCOL SpendWitness input slot (withdraw-w3-ok.json)
    spend_input_slot = {
        "inLabel": label,
        "admittedLeafIndex": path["leafIndex"],
        "admittedPathElements": path["pathElements"],
        "admittedPathIndices": path["pathIndices"],
        "revokedSmtPathElements": smt["pathElements"],
        "revokedSmtPathIndices": smt["pathIndices"],
        "revokedSmtLeaf": smt["claimedLeaf"],  # Circom mapping
    }
    assert len(spend_input_slot["admittedPathElements"]) == 32
    assert len(spend_input_slot["revokedSmtPathElements"]) == 32

    print(
        json.dumps(
            {
                "ok": True,
                "label": label,
                "roots": {
                    "admittedRoot": roots["admittedRoot"],
                    "revokedRoot": roots["revokedRoot"],
                    "admittedLeafCount": roots["admittedLeafCount"],
                },
                "pathLeafIndex": path["leafIndex"],
                "circomRevokedSmtLeaf": spend_input_slot["revokedSmtLeaf"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
