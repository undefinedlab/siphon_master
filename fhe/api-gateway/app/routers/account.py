from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.deps.api_key import verify_api_key
from app.deps.rate_limit import rate_limit
from app.repository.session import get_db
from app.repository.models import ApiKey, UsageEvent
from app.schemas.account import UsageSummary, FeeQuote
from app.schemas.errors_openapi import COMMON_ERRORS
from app.services import credit_service

router = APIRouter(prefix="/v1", tags=["Account"])


@router.get(
    "/account/usage",
    operation_id="getAccountUsage",
    summary="Get integrator-scoped usage summary (metering data + balance)",
    response_model=UsageSummary,
    responses=COMMON_ERRORS,
)
async def get_account_usage(
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> UsageSummary:
    api_key_id = request.state.api_key_id

    # 1. Fetch key balance
    key_row = db.query(ApiKey).filter_by(id=api_key_id).first()
    balance = key_row.balance_minor if key_row else 0

    # 2. Query usage event counts grouped by event_type, and sum total_amount_minor
    results = db.query(
        UsageEvent.event_type,
        func.count(UsageEvent.id).label("count"),
        func.sum(UsageEvent.amount_minor).label("amount_sum")
    ).filter(
        UsageEvent.api_key_id == api_key_id
    ).group_by(
        UsageEvent.event_type
    ).all()

    counts = {}
    total_amount = 0
    for r in results:
        counts[r.event_type] = r.count
        total_amount += int(r.amount_sum or 0)

    # 3. Granted credit from the typed ledger — never re-derived from audit-log JSON, so retention
    #    or compaction of the audit trail cannot silently change what a customer was billed.
    granted_credit = credit_service.sum_by_kind(db, api_key_id, "grant")

    return UsageSummary(
        period="all-time",
        counts_by_event_type=counts,
        total_amount_minor=total_amount,
        granted_credit_minor=granted_credit,
        balance_minor=balance
    )


@router.get(
    "/fees/quote",
    operation_id="getFeeQuote",
    summary="Get upfront arming + execution fee quotes for strategies",
    response_model=FeeQuote,
    responses=COMMON_ERRORS,
)
async def get_fee_quote(
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
) -> FeeQuote:
    # Upfront fee quotes in integer minor units (USDC, 6 decimals). Mirrors the executor's
    # fee model (trade-executor/fee_calc.py): arming 0.25; execution max(0.20 floor,
    # 0.20% notional) + 0.10 flat gas reimbursement.
    return FeeQuote(
        arming_fee_minor=250000,
        execution_fee_minor=200000,
        gas_reimbursement_minor=100000,
    )

