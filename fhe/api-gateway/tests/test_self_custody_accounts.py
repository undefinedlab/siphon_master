"""Self-custody accounts associate public metadata with a user-controlled wallet."""
import pytest

from app.errors import NotFound
from app.repository.models import ApiKey
from app.services import managed_account_service
from app.services import self_custody_account_service as service


def _key(db, key_id: str = "key-1") -> ApiKey:
    row = ApiKey(
        id=key_id,
        key_hash=f"hash-{key_id}",
        integrator_id="business-1",
        plan="test",
        status="active",
    )
    db.add(row)
    db.flush()
    return row


def test_create_records_wallet_but_no_spendable_material(db_session):
    key = _key(db_session)
    account = service.create(
        db_session,
        api_key_id=key.id,
        external_ref="customer-42",
        wallet_address="0x1111111111111111111111111111111111111111",
    )

    assert account.control_mode == "self_custody"
    assert account.owner_address == "0x1111111111111111111111111111111111111111"
    assert not account.keeper_ref.startswith("keeper:")
    assert account.next_note_index == 0


def test_account_view_states_that_api_cannot_spend(db_session):
    key = _key(db_session)
    account = service.create(
        db_session,
        api_key_id=key.id,
        external_ref="customer-42",
        wallet_address="0x1111111111111111111111111111111111111111",
    )

    view = service.public_view(db_session, account)
    assert view["control_mode"] == "self_custody"
    assert view["wallet_address"] == account.owner_address
    assert view["api_key_can_spend"] is False
    assert "fingerprint" not in view


def test_same_wallet_can_be_used_by_different_business_keys(db_session):
    first = _key(db_session, "key-1")
    second = _key(db_session, "key-2")
    wallet = "0x1111111111111111111111111111111111111111"

    one = service.create(
        db_session, api_key_id=first.id, external_ref="user", wallet_address=wallet
    )
    two = service.create(
        db_session, api_key_id=second.id, external_ref="user", wallet_address=wallet
    )
    assert one.id != two.id


def test_self_custody_account_is_invisible_to_legacy_custody_service(db_session):
    key = _key(db_session)
    account = service.create(
        db_session,
        api_key_id=key.id,
        external_ref="customer-42",
        wallet_address="0x1111111111111111111111111111111111111111",
    )

    with pytest.raises(NotFound):
        managed_account_service.get_owned(db_session, account.id, key.id)
    with pytest.raises(NotFound):
        managed_account_service.resolve(db_session, key.id, account.external_ref)
