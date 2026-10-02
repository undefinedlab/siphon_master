"""Policy — versioned, server-enforced controls.

`/policy/evaluate` is a free dry-run: an integrator can check whether a transfer WOULD be permitted
before signing anything, which is what makes a policy usable in a UI rather than only as a rejection
at submit time.
"""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.deps.api_key import verify_api_key
from app.deps.rate_limit import rate_limit
from app.errors import NotFound
from app.repository.session import get_db
from app.schemas.errors_openapi import COMMON_ERRORS, WRITE_ERRORS
from app.schemas.platform import (
    PolicyEvaluateRequest,
    PolicyEvaluateResponse,
    PolicyHistory,
    PolicyPutRequest,
    PolicyView,
)
from app.services import policy_service, sandbox, subaccount_service

router = APIRouter(prefix="/v1", tags=["Policy"])


@router.put(
    "/policy",
    operation_id="putPolicy",
    summary="Replace the active policy (creates a new immutable version)",
    response_model=PolicyView,
    responses=WRITE_ERRORS,
)
async def put_policy(
    body: PolicyPutRequest,
    request: Request,
    key=Depends(verify_api_key),
    _rl=Depends(rate_limit("validate")),
    db: Session = Depends(get_db),
) -> PolicyView:
    row = policy_service.put(
        db,
        api_key_id=request.state.api_key_id,
        rules=body.rules,
        created_by=getattr(key, "integrator_id", None),
    )
    db.commit()
    return PolicyView(**policy_service.public_view(row))


@router.get(
    "/policy",
    operation_id="getPolicy",
    summary="Get the active policy",
    response_model=PolicyView,
    responses=COMMON_ERRORS,
)
async def get_policy(
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> PolicyView:
    row = policy_service.active(db, request.state.api_key_id)
    if row is None:
        raise NotFound("No policy is configured for this API key.")
    return PolicyView(**policy_service.public_view(row))


@router.get(
    "/policy/history",
    operation_id="getPolicyHistory",
    summary="Every policy version, newest first (what was in force, and when)",
    response_model=PolicyHistory,
    responses=COMMON_ERRORS,
)
async def policy_history(
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> PolicyHistory:
    rows = policy_service.history(db, request.state.api_key_id)
    return PolicyHistory(policies=[PolicyView(**policy_service.public_view(r)) for r in rows])


@router.post(
    "/policy/evaluate",
    operation_id="evaluatePolicy",
    summary="Dry-run a transfer against the active policy; free and unmetered",
    response_model=PolicyEvaluateResponse,
    responses=COMMON_ERRORS,
)
async def evaluate_policy(
    body: PolicyEvaluateRequest,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("validate")),
    db: Session = Depends(get_db),
) -> PolicyEvaluateResponse:
    api_key_id = request.state.api_key_id
    sub = subaccount_service.resolve(db, api_key_id, body.subaccount)

    pool: dict = {}
    if sandbox.is_sandbox_request(request) and body.chain_id and body.asset:
        pool = sandbox.fake_pool_state(body.chain_id, body.asset)

    violations, version = policy_service.evaluate(
        db,
        api_key_id=api_key_id,
        chain_id=body.chain_id,
        asset=body.asset,
        amount_minor=body.amount_minor,
        recipient=body.recipient,
        anonymity_set=pool.get("anonymity_set"),
        asp_root_stale=pool.get("asp_root_stale"),
        subaccount_id=sub.id if sub else None,
    )
    return PolicyEvaluateResponse(
        allowed=not violations, violations=violations, policy_version=version
    )
