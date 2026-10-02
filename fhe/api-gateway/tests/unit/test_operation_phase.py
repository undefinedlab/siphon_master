from app.repository.models import ApiKey
from app.schemas.compliance import BusinessOperationState
from app.services import operation_service
from app.services.operation_service import _TRANSITIONS, public_phase


def test_public_operation_phase_is_exhaustive_and_stable():
    states = {state.value if isinstance(state, BusinessOperationState) else state for state in _TRANSITIONS}
    assert {public_phase(state) for state in states} == {
        "pending", "action_required", "processing", "succeeded", "failed"
    }
    assert all(public_phase(state) for state in states)


def test_chain_refresh_advances_submitted_operation_without_client_poll(monkeypatch, db_session):
    key = ApiKey(
        id="key-1", key_hash="hash", integrator_id="business", plan="test", status="active"
    )
    db_session.add(key)
    operation = operation_service.create(
        db_session,
        api_key_id=key.id,
        kind="payout",
        chain_id=8453,
        state=BusinessOperationState.submitted,
    )
    operation.tx_hash = "0x" + "ab" * 32
    db_session.flush()

    class Eth:
        def get_transaction_receipt(self, _tx_hash):
            return {"status": 1, "blockNumber": 1}

    class FakeWeb3:
        def __init__(self, _provider):
            self.eth = Eth()

        @staticmethod
        def HTTPProvider(url):
            return url

    monkeypatch.setattr("web3.Web3", FakeWeb3)
    monkeypatch.setattr("app.services.confirmations.is_confirmed", lambda *_: True)

    assert operation_service.refresh_chain_state(db_session, operation) is True
    assert operation.state == BusinessOperationState.confirmed.value
