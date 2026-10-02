import pytest

from app.deps.idempotency import idempotent, request_hash
from app.errors import IdempotencyKeyReuse
from app.repository.models import IdempotencyKey


def test_same_client_key_is_isolated_by_server_scope(db_session):
    body = {"chain_id": 8453, "amount_minor": 1}
    with idempotent(db_session, "request-1", body, scope="business-a\0wallet-a\0POST\0/v1/payouts") as ctx:
        assert ctx.stored is None
        ctx.store(200, {"operation_id": "a"})

    with idempotent(db_session, "request-1", body, scope="business-b\0wallet-b\0POST\0/v1/payouts") as ctx:
        assert ctx.stored is None
        ctx.store(200, {"operation_id": "b"})

    assert db_session.query(IdempotencyKey).count() == 2


def test_scoped_cutover_never_replays_or_leaks_a_legacy_global_response(db_session):
    db_session.add(IdempotencyKey(
        key="old-key",
        request_hash=request_hash({"amount_minor": 1}),
        response_body={"operation_id": "possibly-another-tenant"},
        status_code=200,
        status="completed",
    ))
    db_session.flush()

    with pytest.raises(IdempotencyKeyReuse):
        with idempotent(
            db_session,
            "old-key",
            {"amount_minor": 1},
            scope="business-a\0wallet-a\0POST\0/v1/payouts",
        ):
            pass
