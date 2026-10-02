"""Subaccounts — per-tenant isolation inside one integrator's API key."""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.deps.api_key import verify_api_key
from app.deps.rate_limit import rate_limit
from app.errors import BadRequest
from app.repository.models import Subaccount
from app.repository.session import get_db
from app.schemas.errors_openapi import COMMON_ERRORS, WRITE_ERRORS
from app.schemas.platform import (
    SubaccountCreateRequest,
    SubaccountList,
    SubaccountUpdateRequest,
    SubaccountView,
)
from app.services import subaccount_service

router = APIRouter(prefix="/v1", tags=["Subaccounts"])


@router.post(
    "/subaccounts",
    operation_id="createSubaccount",
    summary="Create a tenant subaccount with its own spend cap and rate budget",
    response_model=SubaccountView,
    responses=WRITE_ERRORS,
)
async def create_subaccount(
    body: SubaccountCreateRequest,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("validate")),
    db: Session = Depends(get_db),
) -> SubaccountView:
    row = subaccount_service.create(
        db,
        api_key_id=request.state.api_key_id,
        external_id=body.external_id,
        label=body.label,
        spend_cap_minor=body.spend_cap_minor,
        rate_limit_per_min=body.rate_limit_per_min,
    )
    db.commit()
    return SubaccountView(**subaccount_service.public_view(db, row))


@router.get(
    "/subaccounts",
    operation_id="listSubaccounts",
    summary="List subaccounts with live spend against each cap",
    response_model=SubaccountList,
    responses=COMMON_ERRORS,
)
async def list_subaccounts(
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> SubaccountList:
    rows = (
        db.query(Subaccount)
        .filter(Subaccount.api_key_id == request.state.api_key_id)
        .order_by(Subaccount.created_at.desc())
        .all()
    )
    return SubaccountList(
        subaccounts=[SubaccountView(**subaccount_service.public_view(db, r)) for r in rows]
    )


@router.get(
    "/subaccounts/{id}",
    operation_id="getSubaccount",
    summary="Get one subaccount (accepts our id or your external_id)",
    response_model=SubaccountView,
    responses=COMMON_ERRORS,
)
async def get_subaccount(
    id: str,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> SubaccountView:
    row = subaccount_service.resolve(db, request.state.api_key_id, id)
    return SubaccountView(**subaccount_service.public_view(db, row))


@router.patch(
    "/subaccounts/{id}",
    operation_id="updateSubaccount",
    summary="Update label, status, spend cap, or rate budget",
    response_model=SubaccountView,
    responses=WRITE_ERRORS,
)
async def update_subaccount(
    id: str,
    body: SubaccountUpdateRequest,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("validate")),
    db: Session = Depends(get_db),
) -> SubaccountView:
    row = subaccount_service.resolve(db, request.state.api_key_id, id)

    if body.status is not None:
        if body.status not in ("active", "suspended"):
            raise BadRequest("status must be 'active' or 'suspended'.")
        row.status = body.status
    if body.label is not None:
        row.label = body.label
    if body.spend_cap_minor is not None:
        row.spend_cap_minor = body.spend_cap_minor
    if body.rate_limit_per_min is not None:
        row.rate_limit_per_min = body.rate_limit_per_min

    db.flush()
    db.commit()
    return SubaccountView(**subaccount_service.public_view(db, row))
