"""Operations — the durable resource that replaces polling the call that created the work.

`GET /v1/operations/{id}` is the one endpoint an integrator's job runner needs; everything else in
the platform surface refers back to an operation id.
"""
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.deps.api_key import verify_api_key
from app.deps.rate_limit import rate_limit
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox
from app.errors import Conflict, Forbidden
from app.repository.session import get_db
from app.schemas.errors_openapi import COMMON_ERRORS
from app.schemas.platform import OperationList, OperationView
from app.schemas.business import OperationSubmissionRequest
from app.schemas.errors_openapi import WRITE_ERRORS
from app.schemas.compliance import BusinessOperationState as S
from app.services import operation_service, subaccount_service

router = APIRouter(prefix="/v1", tags=["Operations"])


@router.get(
    "/operations",
    operation_id="listOperations",
    summary="List operations (newest first, cursor-paginated)",
    response_model=OperationList,
    responses=COMMON_ERRORS,
)
async def list_operations(
    request: Request,
    state: str | None = Query(default=None, description="Filter by business operation state."),
    kind: str | None = Query(default=None, description="withdrawal | deposit | consolidation | strategy"),
    subaccount: str | None = Query(default=None, description="Subaccount id or your external_id."),
    batch_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None),
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> OperationList:
    api_key_id = request.state.api_key_id
    sub = subaccount_service.resolve(db, api_key_id, subaccount)

    rows, next_cursor = operation_service.list_owned(
        db,
        api_key_id,
        state=state,
        kind=kind,
        subaccount_id=sub.id if sub else None,
        batch_id=batch_id,
        limit=limit,
        cursor=cursor,
    )
    return OperationList(
        operations=[OperationView(**operation_service.public_view(r)) for r in rows],
        next_cursor=next_cursor,
    )


@router.get(
    "/operations/{id}",
    operation_id="getOperation",
    summary="Get one operation (404 if not owned by the caller)",
    response_model=OperationView,
    responses=COMMON_ERRORS,
)
async def get_operation(
    id: str,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> OperationView:
    op = operation_service.get_owned(db, id, request.state.api_key_id)
    operation_service.refresh_chain_state(db, op)
    db.commit()
    return OperationView(**operation_service.public_view(op))


@router.post(
    "/operations/{id}/submission",
    operation_id="submitOperationTransaction",
    summary="Attach the exact broadcast transaction to an unsigned operation",
    response_model=OperationView,
    responses=WRITE_ERRORS,
)
async def submit_operation_transaction(
    id: str,
    body: OperationSubmissionRequest,
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("validate")),
    db: Session = Depends(get_db),
) -> OperationView:
    op = operation_service.get_owned(db, id, request.state.api_key_id)
    if not op.wallet or op.wallet.lower() != wallet.lower():
        raise Forbidden("The signing wallet does not control this operation.")
    if op.chain_id != body.chain_id:
        raise Conflict("Transaction chain does not match the operation.")
    if op.state not in (S.awaiting_deposit.value, S.authorized.value):
        raise Conflict("Operation is not awaiting an unsigned transaction submission.")
    detail = op.detail or {}
    expected_to = detail.get("expected_to")
    expected_data_hash = detail.get("expected_data_sha256")
    if not expected_to or not expected_data_hash:
        raise Conflict("Operation has no verifiable unsigned transaction plan.")

    if not getattr(request.state, "sandbox", False) and detail.get("protocol") == "solana":
        from app.services import solana_devnet

        solana_devnet.validate_submitted_deposit(
            body.tx_hash, wallet=op.wallet, expected_data_sha256=expected_data_hash
        )
    elif not getattr(request.state, "sandbox", False):
        from app.services.confirmations import validate_submitted_transaction

        validate_submitted_transaction(
            body.chain_id,
            body.tx_hash,
            expected_to=expected_to,
            expected_data_sha256=expected_data_hash,
        )
    operation_service.transition(db, op, S.submitted, tx_hash=body.tx_hash)
    db.commit()
    return OperationView(**operation_service.public_view(op))
