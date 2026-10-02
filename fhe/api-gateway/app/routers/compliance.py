"""Compliance receipts — the exportable artifact an auditor accepts.

`/export` returns a self-contained document that verifies offline, without calling this API. That
matters: an auditor reviewing a transaction two years from now should not need a live credential
against a running gateway to check that screening happened.
"""
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.deps.api_key import verify_api_key
from app.deps.rate_limit import rate_limit
from app.repository.models import ComplianceReceipt
from app.repository.session import get_db
from app.schemas.errors_openapi import COMMON_ERRORS
from app.schemas.platform import (
    ReceiptExport,
    ReceiptList,
    ReceiptVerifyResponse,
    ReceiptView,
)
from app.services import compliance_receipt_service as receipts
from app.services import operation_service

router = APIRouter(prefix="/v1", tags=["Compliance"])


def _view(r: ComplianceReceipt) -> ReceiptView:
    return ReceiptView(
        receipt_id=r.id,
        operation_id=r.operation_id,
        subject_address=r.subject_address,
        chain_id=r.chain_id,
        result=r.result,
        list_version=r.list_version,
        asp_root=r.asp_root,
        attestation_digest=r.attestation_digest,
        policy_version=r.policy_version,
        screened_at=r.screened_at,
        signature=r.signature,
        key_id=r.key_id,
    )


@router.get(
    "/receipts",
    operation_id="listComplianceReceipts",
    summary="List compliance receipts for the caller",
    response_model=ReceiptList,
    responses=COMMON_ERRORS,
)
async def list_receipts(
    request: Request,
    result: str | None = Query(default=None, description="pass | deny"),
    limit: int = Query(default=50, ge=1, le=200),
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> ReceiptList:
    q = db.query(ComplianceReceipt).filter(
        ComplianceReceipt.api_key_id == request.state.api_key_id
    )
    if result:
        q = q.filter(ComplianceReceipt.result == result)
    rows = q.order_by(ComplianceReceipt.created_at.desc()).limit(limit).all()
    return ReceiptList(receipts=[_view(r) for r in rows])


@router.get(
    "/operations/{id}/receipts",
    operation_id="getOperationReceipts",
    summary="Compliance receipts minted for one operation",
    response_model=ReceiptList,
    responses=COMMON_ERRORS,
)
async def operation_receipts(
    id: str,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> ReceiptList:
    api_key_id = request.state.api_key_id
    operation_service.get_owned(db, id, api_key_id)  # ownership check first (404 if not theirs)
    rows = receipts.for_operation(db, id, api_key_id)
    return ReceiptList(receipts=[_view(r) for r in rows])


@router.get(
    "/receipts/{id}/export",
    operation_id="exportComplianceReceipt",
    summary="Self-contained receipt document that verifies offline",
    response_model=ReceiptExport,
    responses=COMMON_ERRORS,
)
async def export_receipt(
    id: str,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> ReceiptExport:
    row = receipts.get_owned(db, id, request.state.api_key_id)
    return ReceiptExport(**receipts.export_view(row))


@router.get(
    "/receipts/{id}/verify",
    operation_id="verifyComplianceReceipt",
    summary="Check a stored receipt's signature",
    response_model=ReceiptVerifyResponse,
    responses=COMMON_ERRORS,
)
async def verify_receipt(
    id: str,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> ReceiptVerifyResponse:
    row = receipts.get_owned(db, id, request.state.api_key_id)
    return ReceiptVerifyResponse(receipt_id=row.id, valid=receipts.verify(row), key_id=row.key_id)
