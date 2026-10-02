"""Batches — one authorization over many recipients.

The create path runs the same gates as a single withdrawal, in the same fail-closed order:
sanctions -> policy -> subaccount cap. It runs them over the WHOLE batch before creating anything,
so a batch is never half-authorized: either every item was screened and permitted, or nothing was
created.
"""
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.deps.api_key import verify_api_key
from app.deps.idempotency import idempotent, request_scope
from app.deps.rate_limit import rate_limit
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox
from app.repository.models import Batch
from app.repository.session import get_db
from app.schemas.errors_openapi import COMMON_ERRORS, WRITE_ERRORS
from app.schemas.platform import BatchCreateRequest, BatchDetail, BatchList, BatchView, OperationView
from app.services import batch_service, operation_service, policy_service, sandbox, subaccount_service
from app.services import compliance_receipt_service as receipts

router = APIRouter(prefix="/v1", tags=["Batches"])


@router.post(
    "/batches",
    operation_id="createBatch",
    summary="Authorize a batch payout/payroll run (screened + policy-gated as one unit)",
    response_model=BatchView,
    responses=WRITE_ERRORS,
)
async def create_batch(
    body: BatchCreateRequest,
    request: Request,
    key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
    db: Session = Depends(get_db),
) -> BatchView:
    api_key_id = request.state.api_key_id
    sandbox.apply_scenario(request)

    sub = subaccount_service.resolve(db, api_key_id, body.subaccount)
    total = sum(i.amount_minor for i in body.items)

    idem_key = request.headers.get("Idempotency-Key")
    with idempotent(db, idem_key, body.model_dump(), scope=request_scope(request, wallet=wallet)) as ctx:
        if ctx.stored is not None:
            status_code, resp_body = ctx.stored
            if status_code >= 400:
                from fastapi.responses import JSONResponse

                return JSONResponse(status_code=status_code, content=resp_body)
            return BatchView(**resp_body)

        # 1. Screen every recipient AND the sender before anything is created (fail-closed).
        pool = _pool_state(request, body.chain_id, body.asset)
        screened = [wallet] + [i.recipient for i in body.items]
        for addr in screened:
            _screen(request, addr, body.chain_id)

        # 2. Policy over the batch as a whole, and per item.
        policy_version = policy_service.enforce(
            db,
            api_key_id=api_key_id,
            chain_id=body.chain_id,
            asset=body.asset,
            amount_minor=total,
            anonymity_set=pool.get("anonymity_set"),
            asp_root_stale=pool.get("asp_root_stale"),
            subaccount_id=sub.id if sub else None,
        )
        for item in body.items:
            policy_service.enforce(
                db,
                api_key_id=api_key_id,
                chain_id=body.chain_id,
                asset=body.asset,
                amount_minor=item.amount_minor,
                recipient=item.recipient,
                anonymity_set=pool.get("anonymity_set"),
                asp_root_stale=pool.get("asp_root_stale"),
                subaccount_id=sub.id if sub else None,
            )

        # 3. Spend cap for the whole run.
        subaccount_service.assert_can_spend(db, sub, total)

        batch = batch_service.create(
            db,
            api_key_id=api_key_id,
            chain_id=body.chain_id,
            asset=body.asset,
            items=[i.model_dump() for i in body.items],
            subaccount_id=sub.id if sub else None,
            wallet=wallet,
            kind=body.kind,
        )

        # 4. Mint a compliance receipt per screened address, bound to the batch's operations.
        ops = batch_service.items(db, batch.id)
        by_recipient = {(o.recipient or "").lower(): o for o in ops}
        for addr in screened:
            op = by_recipient.get((addr or "").lower())
            receipts.mint(
                db,
                api_key_id=api_key_id,
                subject_address=addr,
                result="pass",
                operation_id=op.id if op else None,
                chain_id=body.chain_id,
                list_version=pool.get("list_version"),
                asp_root=pool.get("asp_root"),
                attestation_digest=pool.get("attestation_digest"),
                policy_version=policy_version,
            )

        view = batch_service.public_view(db, batch)
        ctx.store(200, _jsonable(view))
        db.commit()
        return BatchView(**view)


def _jsonable(d: dict) -> dict:
    from datetime import datetime

    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in d.items()}


def _pool_state(request: Request, chain_id: int, asset: str) -> dict:
    """Privacy + compliance context for the policy gate.

    In sandbox this is deterministic fixture data. In production it comes from the indexer / ASP;
    values that cannot be determined stay absent so the policy engine fails closed on them rather
    than treating 'unknown' as 'fine'.
    """
    if sandbox.is_sandbox_request(request):
        state = sandbox.fake_pool_state(chain_id, asset)
        state["list_version"] = sandbox.fake_list_version()
        state["attestation_digest"] = sandbox.fake_attestation_digest(chain_id)
        return state
    return {}


def _screen(request: Request, address: str, chain_id: int) -> None:
    if sandbox.is_sandbox_request(request):
        return  # scenario forcing already handled by apply_scenario
    from app.services.sanctions import screen_address

    screen_address(address, chain_id)


@router.get(
    "/batches",
    operation_id="listBatches",
    summary="List batches",
    response_model=BatchList,
    responses=COMMON_ERRORS,
)
async def list_batches(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> BatchList:
    rows = (
        db.query(Batch)
        .filter(Batch.api_key_id == request.state.api_key_id)
        .order_by(Batch.created_at.desc())
        .limit(limit)
        .all()
    )
    return BatchList(batches=[BatchView(**batch_service.public_view(db, r)) for r in rows])


@router.get(
    "/batches/{id}",
    operation_id="getBatch",
    summary="Get a batch with per-item operation state",
    response_model=BatchDetail,
    responses=COMMON_ERRORS,
)
async def get_batch(
    id: str,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> BatchDetail:
    batch = batch_service.get_owned(db, id, request.state.api_key_id)
    batch_service.refresh_state(db, batch)
    ops = batch_service.items(db, batch.id)
    return BatchDetail(
        **batch_service.public_view(db, batch),
        items=[OperationView(**operation_service.public_view(o)) for o in ops],
    )
