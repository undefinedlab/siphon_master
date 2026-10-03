"""Solana ZK vault ASP: event decoding, state-root parity, watcher admission."""
from __future__ import annotations

import base64
import os
from unittest.mock import patch

import pytest

os.environ.setdefault("ASP_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("SOLANA_ZK_PROGRAM_ID", "F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH")

import config
import db
from db import SolanaLeaf, init_db, session
from screen import screen
from solana_chain_ids import SOLANA_DEVNET_CHAIN_ID as SOL
from solana_rpc import (
    DEPOSIT_EVENT_DISC,
    LEAF_INSERTED_DISC,
    b58encode,
    decode_leaf_events,
    field_to_le32,
)

DEP = "F6zdhuEKdWymqk4bLW8KAAooy6yEjwWQX3XKuXpZqPsq"
OTHER = "8jXNBuL2xpGfkc3jBTYbPZZQP7i8oEkT3PwVj4yg4EcV"
WSOL = "So11111111111111111111111111111111111111112"


def _b58decode(text: str) -> bytes:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = 0
    for c in text:
        n = n * 58 + alphabet.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\x00" * (len(text) - len(text.lstrip("1"))) + raw


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setattr(config, "REQUIRE_SEEDED_LISTS", False)
    monkeypatch.setattr(config, "ZKME_MCH_NO", "")
    monkeypatch.setattr(config, "ZKME_API_KEY", "")
    monkeypatch.setattr(config, "SCREEN_ADMIT_RECHECK", False)
    monkeypatch.setattr(config, "SCREEN_ADMIT_MAX_AGE_SEC", 3600)
    db._engine = None
    db.SessionLocal = None
    init_db()
    yield


def test_decode_deposit_and_leaf_inserted():
    deposit = (
        DEPOSIT_EVENT_DISC
        + _b58decode(DEP)
        + _b58decode(WSOL)
        + field_to_le32(12345)
        + (7).to_bytes(8, "little")
        + (6).to_bytes(8, "little")
    )
    change = LEAF_INSERTED_DISC + field_to_le32(999) + (8).to_bytes(8, "little")
    logs = [
        "Program log: Instruction: Deposit",
        "Program data: " + base64.b64encode(deposit).decode(),
        "Program data: " + base64.b64encode(change).decode(),
        "Program data: " + base64.b64encode(b"\x00" * 40).decode(),  # foreign event ignored
    ]
    evs = decode_leaf_events(logs, signature="sig", slot=1)
    assert [e.kind for e in evs] == ["deposit", "change"]
    d, c = evs
    assert (d.depositor, d.mint, d.commitment, d.leaf_index, d.deposit_nonce) == (DEP, WSOL, "12345", 7, 6)
    assert (c.commitment, c.leaf_index, c.depositor) == ("999", 8, None)
    assert b58encode(_b58decode(DEP)) == DEP


def test_state_root_matches_incremental_tree(poseidon_ready):
    """Batch rebuild (indexer) and incremental insert (program / AspTree) agree."""
    from core.asp_tree import AspTree
    from solana_indexer import compute_root

    assert compute_root([]) == AspTree().root()
    tree = AspTree()
    leaves = [11, 22, 33]
    for v in leaves:
        tree.insert(v)
    assert compute_root(leaves) == tree.root()


def _deposit_leaf(s, *, commitment: str, depositor: str = DEP, index: int = 0, nonce: int = 0):
    s.add(
        SolanaLeaf(
            chain_id=SOL,
            leaf_index=index,
            commitment=commitment,
            kind="deposit",
            depositor=depositor,
            mint=WSOL,
            deposit_nonce=nonce,
            signature=f"sig{index}",
            slot=100 + index,
        )
    )
    s.commit()


def test_watcher_admits_screened_deposit(poseidon_ready):
    from association_set import is_admitted
    from core.label import derive_deposit_label
    from db import AspLabel
    from pending_admit import upsert_pending_admit
    from scripts.watch_deposits_solana import admit_pending
    from solana_indexer import vault_pda

    with patch("screen.is_sanctioned", return_value=False):
        with session() as s:
            screen(s, chain_id=SOL, depositor=DEP, commitment="4242", persist=True)
            upsert_pending_admit(s, chain_id=SOL, commitment="4242", user_salt="5", depositor=DEP)
            s.commit()
            _deposit_leaf(s, commitment="4242", nonce=3)

            out = admit_pending(s, chain_id=SOL)
            assert out == {"admitted": 1, "waitingForScreen": 0, "errors": 0}

            label = derive_deposit_label(
                chain_id=SOL,
                vault_address=vault_pda(),
                deposit_nonce=3,
                user_salt=5,
                program_id=os.environ["SOLANA_ZK_PROGRAM_ID"],
            )
            assert is_admitted(s, str(label))
            row = s.query(AspLabel).one()
            assert row.depositor == DEP  # base58 case preserved
            assert s.query(SolanaLeaf).one().admit_status == "admitted"


def test_watcher_waits_for_late_screen(poseidon_ready):
    from scripts.watch_deposits_solana import admit_pending

    with session() as s:
        _deposit_leaf(s, commitment="5151")
        assert admit_pending(s, chain_id=SOL)["waitingForScreen"] == 1
        assert s.query(SolanaLeaf).one().admit_status is None


def test_watcher_rejects_depositor_mismatch(poseidon_ready):
    from pending_admit import upsert_pending_admit
    from scripts.watch_deposits_solana import admit_pending

    with patch("screen.is_sanctioned", return_value=False):
        with session() as s:
            screen(s, chain_id=SOL, depositor=DEP, commitment="6161", persist=True)
            upsert_pending_admit(s, chain_id=SOL, commitment="6161", user_salt="9", depositor=DEP)
            s.commit()
            _deposit_leaf(s, commitment="6161", depositor=OTHER)
            assert admit_pending(s, chain_id=SOL)["errors"] == 1
            assert s.query(SolanaLeaf).one().admit_status == "failed"
