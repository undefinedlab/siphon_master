"""Managed accounts — enclave-custodied shielded accounts.

The failures worth testing here are all silent:

* a note index reused → the keeper derives the SAME note twice → a duplicate leaf that can never be
  independently spent;
* `keeper_ref` not namespaced → two integrators derive identical notes and can spend each other's
  funds;
* secret material reaching the gateway → spendable keys in the database, logs and backups, which
  defeats the entire custody model.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.errors import Conflict, NotFound
from app.repository.models import ApiKey, Base, ManagedNote
from app.services import managed_account_service as svc


class FakeKeeper:
    """Stands in for the enclave. Mirrors its determinism so index reuse is observable."""

    def __init__(self):
        self.allocations = []

    def derive_account(self, keeper_ref: str) -> dict:
        return {
            "account_ref": keeper_ref,
            "fingerprint": f"fp_{abs(hash(keeper_ref)) % (10**12):012d}",
            "owner_address": "0x" + f"{abs(hash(keeper_ref)) % (16**40):040x}",
        }

    def allocate_note(self, *, keeper_ref, index, amount, label=None, scope=None, nonce=None) -> dict:
        self.allocations.append((keeper_ref, index))
        # Deterministic on (ref, index) exactly like the real keeper.
        base = abs(hash((keeper_ref, index)))
        return {
            "label": str(label if label is not None else base % 10**20),
            "precommitment": str(base % 10**30),
            "commitment": str((base * 7) % 10**30),
            "nullifier_hash": str((base * 13) % 10**30),
        }

    def reconstruct(self, *, keeper_ref, start, count, amount=0, label=0) -> dict:
        return {"notes": [
            {"index": i, "precommitment": str(abs(hash((keeper_ref, i))) % 10**30),
             "nullifier_hash": str(abs(hash((keeper_ref, i))) % 10**29)}
            for i in range(start, start + count)
        ]}


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, expire_on_commit=False)()
    yield s
    s.close()


@pytest.fixture()
def keeper():
    return FakeKeeper()


def _key(db, h="h1", integ="0xint"):
    row = ApiKey(key_hash=h, integrator_id=integ, plan="test", balance_minor=0)
    db.add(row)
    db.flush()
    return row


# --- tenant isolation -------------------------------------------------------------------------

def test_keeper_ref_is_namespaced_by_api_key():
    """Two integrators using the same external_ref must NOT derive the same notes."""
    a = svc.keeper_ref("key-aaa", "customer-1")
    b = svc.keeper_ref("key-bbb", "customer-1")
    assert a != b
    assert a.startswith("key-aaa:")


def test_two_integrators_same_external_ref_get_different_material(db, keeper):
    k1, k2 = _key(db, "h1", "0xone"), _key(db, "h2", "0xtwo")
    a1 = svc.create(db, keeper, api_key_id=k1.id, external_ref="customer-1")
    a2 = svc.create(db, keeper, api_key_id=k2.id, external_ref="customer-1")
    assert a1.keeper_ref != a2.keeper_ref
    assert a1.fingerprint != a2.fingerprint


def test_account_not_readable_cross_tenant(db, keeper):
    k1, k2 = _key(db, "h1"), _key(db, "h2", "0xother")
    acct = svc.create(db, keeper, api_key_id=k1.id, external_ref="c1")
    with pytest.raises(NotFound):
        svc.get_owned(db, acct.id, k2.id)
    with pytest.raises(NotFound):
        svc.resolve(db, k2.id, acct.external_ref)


def test_duplicate_external_ref_rejected(db, keeper):
    k = _key(db)
    svc.create(db, keeper, api_key_id=k.id, external_ref="dup")
    with pytest.raises(Conflict):
        svc.create(db, keeper, api_key_id=k.id, external_ref="dup")


# --- index allocation -------------------------------------------------------------------------

def test_indices_are_never_reused(db, keeper):
    """Keeper derivation is deterministic on index; a reused index mints a duplicate note."""
    k = _key(db)
    acct = svc.create(db, keeper, api_key_id=k.id, external_ref="c1")

    indices = [svc.allocate_index(db, acct) for _ in range(10)]
    assert indices == list(range(10))
    assert len(set(indices)) == 10


def test_allocated_notes_have_distinct_commitments(db, keeper):
    k = _key(db)
    acct = svc.create(db, keeper, api_key_id=k.id, external_ref="c1")
    notes = [
        svc.allocate_note(db, keeper, account=acct, chain_id=8453, asset="USDC",
                          amount_minor=100, scope=1, nonce=i)
        for i in range(5)
    ]
    assert len({n.commitment for n in notes}) == 5
    assert [n.note_index for n in notes] == [0, 1, 2, 3, 4]
    # every keeper call used a distinct index
    assert len({idx for _ref, idx in keeper.allocations}) == 5


def test_duplicate_index_is_rejected_by_the_database(db, keeper):
    """Backstop for a bypassed row lock or a racing retry."""
    from sqlalchemy.exc import IntegrityError

    k = _key(db)
    acct = svc.create(db, keeper, api_key_id=k.id, external_ref="c1")
    svc.allocate_note(db, keeper, account=acct, chain_id=8453, asset="USDC",
                      amount_minor=100, scope=1, nonce=0)

    db.add(ManagedNote(
        account_id=acct.id, api_key_id=k.id, note_index=0, chain_id=8453, asset="USDC",
        amount_minor=100, label="1", precommitment="1", commitment="2", nullifier_hash="3",
    ))
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


# --- the secret boundary ----------------------------------------------------------------------

def test_persisted_note_carries_no_secret_material(db, keeper):
    k = _key(db)
    acct = svc.create(db, keeper, api_key_id=k.id, external_ref="c1")
    note = svc.allocate_note(db, keeper, account=acct, chain_id=8453, asset="USDC",
                             amount_minor=100, scope=1, nonce=0)

    columns = {c.name for c in ManagedNote.__table__.columns}
    assert "nullifier" not in columns and "secret" not in columns
    assert "nullifier_hash" in columns  # the public marker IS stored

    view = svc.note_view(note)
    assert "nullifier" not in view and "secret" not in view


def test_keeper_client_rejects_secret_bearing_responses():
    """The tripwire: if the enclave ever returned spendable material, the gateway must refuse it
    rather than write it to the database."""
    from app.adapters.keeper import _assert_no_secrets

    _assert_no_secrets({"commitment": "1", "nullifier_hash": "2"})  # fine
    for bad in ({"nullifier": "1"}, {"secret": "1"}, {"notes": [{"secret": "x"}]}):
        with pytest.raises(RuntimeError):
            _assert_no_secrets(bad)


# --- balances ---------------------------------------------------------------------------------

def test_pending_deposits_are_not_balance(db, keeper):
    """An unmined deposit must not read as spendable value."""
    k = _key(db)
    acct = svc.create(db, keeper, api_key_id=k.id, external_ref="c1")
    note = svc.allocate_note(db, keeper, account=acct, chain_id=8453, asset="USDC",
                             amount_minor=5_000, scope=1, nonce=0)
    assert note.status == "pending"
    assert svc.balance_minor(db, acct.id) == 0

    svc.confirm_note(db, note, tx_hash="0xabc")
    assert svc.balance_minor(db, acct.id) == 5_000


def test_spent_notes_leave_the_balance(db, keeper):
    k = _key(db)
    acct = svc.create(db, keeper, api_key_id=k.id, external_ref="c1")
    n1 = svc.allocate_note(db, keeper, account=acct, chain_id=8453, asset="USDC",
                           amount_minor=1_000, scope=1, nonce=0)
    n2 = svc.allocate_note(db, keeper, account=acct, chain_id=8453, asset="USDC",
                           amount_minor=2_000, scope=1, nonce=1)
    svc.confirm_note(db, n1)
    svc.confirm_note(db, n2)
    assert svc.balance_minor(db, acct.id) == 3_000

    n1.status = "spent"
    db.flush()
    assert svc.balance_minor(db, acct.id) == 2_000


def test_balance_is_scoped_by_chain_and_asset(db, keeper):
    k = _key(db)
    acct = svc.create(db, keeper, api_key_id=k.id, external_ref="c1")
    for chain, asset, amt in ((8453, "USDC", 100), (11155111, "USDC", 200), (8453, "ETH", 300)):
        n = svc.allocate_note(db, keeper, account=acct, chain_id=chain, asset=asset,
                              amount_minor=amt, scope=1, nonce=chain + amt)
        svc.confirm_note(db, n)

    assert svc.balance_minor(db, acct.id) == 600
    assert svc.balance_minor(db, acct.id, chain_id=8453) == 400
    assert svc.balance_minor(db, acct.id, chain_id=8453, asset="USDC") == 100


def test_inactive_account_cannot_allocate(db, keeper):
    k = _key(db)
    acct = svc.create(db, keeper, api_key_id=k.id, external_ref="c1")
    acct.status = "suspended"
    db.flush()
    with pytest.raises(Conflict):
        svc.allocate_note(db, keeper, account=acct, chain_id=8453, asset="USDC",
                          amount_minor=100, scope=1, nonce=0)


def test_zero_or_negative_amount_rejected(db, keeper):
    k = _key(db)
    acct = svc.create(db, keeper, api_key_id=k.id, external_ref="c1")
    for bad in (0, -5):
        with pytest.raises(Conflict):
            svc.allocate_note(db, keeper, account=acct, chain_id=8453, asset="USDC",
                              amount_minor=bad, scope=1, nonce=0)


# --- recovery ---------------------------------------------------------------------------------

def test_recovery_reconstructs_indices_from_the_enclave(db, keeper):
    """The capability random note secrets cannot offer: rebuild from the master key alone."""
    k = _key(db)
    acct = svc.create(db, keeper, api_key_id=k.id, external_ref="c1")
    out = keeper.reconstruct(keeper_ref=acct.keeper_ref, start=0, count=5)
    assert [n["index"] for n in out["notes"]] == [0, 1, 2, 3, 4]
    assert all("secret" not in n and "nullifier" not in n for n in out["notes"])
