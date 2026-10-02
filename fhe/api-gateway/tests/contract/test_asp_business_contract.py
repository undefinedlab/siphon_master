"""Frozen public API vocabulary for Hard ASP-backed business operations."""
from app.schemas.compliance import BusinessOperationState, OperationStatus
from app.schemas.common import ErrorCode


def test_business_operation_states_hide_internal_cryptographic_workflow():
    assert {state.value for state in BusinessOperationState} == {
        "created",
        "awaiting_deposit",
        "screening",
        "compliance_pending",
        "ready",
        "denied",
        "authorized",
        "proving",
        "queued",
        "submitted",
        "confirmed",
        "failed",
        "revoked",
        "ragequit_submitted",
        "ragequit_confirmed",
    }

    public_fields = set(OperationStatus.model_json_schema()["properties"])
    assert public_fields == {"operation_id", "status", "updated_at", "retryable"}
    assert not public_fields & {
        "label",
        "path",
        "root",
        "nullifier",
        "secret",
        "proof",
        "precommitment",
    }


def test_hard_asp_business_errors_are_stable_machine_codes():
    assert {
        ErrorCode.compliance_pending.value,
        ErrorCode.compliance_denied.value,
        ErrorCode.asp_unavailable.value,
        ErrorCode.asp_root_stale.value,
        ErrorCode.proof_failed.value,
        ErrorCode.transaction_failed.value,
    } == {
        "compliance_pending",
        "compliance_denied",
        "asp_unavailable",
        "asp_root_stale",
        "proof_failed",
        "transaction_failed",
    }
