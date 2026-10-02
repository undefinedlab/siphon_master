from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.deps.admin_auth import require_admin_token
from app.deps.idempotency import idempotent
from app.repository.session import get_db
from app.schemas.admin import CreditGrantRequest, CreditGrantResponse
from app.services import credit_service

# Exclude all admin routes from the public OpenAPI schema
router = APIRouter(tags=["Admin"], include_in_schema=False)


@router.post(
    "/admin/keys/{id}/credit",
    response_model=CreditGrantResponse,
)
async def grant_credit(
    id: str,
    body: CreditGrantRequest,
    request: Request,
    _auth=Depends(require_admin_token),
    db: Session = Depends(get_db),
) -> CreditGrantResponse:
    request_id = getattr(request.state, "request_id", "req_unknown")
    idem_key = request.headers.get("Idempotency-Key")

    with idempotent(db, idem_key, body.model_dump(), scope=f"admin-credit:{id}") as ctx:
        if ctx.stored is not None:
            status_code, resp_body = ctx.stored
            if status_code >= 400:
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=status_code, content=resp_body)
            return CreditGrantResponse(**resp_body)

        res = credit_service.grant(
            db,
            api_key_id=id,
            amount_minor=body.amount_minor,
            reason=body.reason,
            request_id=request_id
        )

        ctx.store(200, res)
        db.commit()
        return CreditGrantResponse(**res)
