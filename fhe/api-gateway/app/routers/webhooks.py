"""Webhook endpoint management + delivery introspection.

The secret is returned exactly once, at creation. Everything else about an endpoint is readable, but
re-showing the signing secret would put it in a log or a support ticket eventually — rotate instead.
"""
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.deps.api_key import verify_api_key
from app.deps.rate_limit import rate_limit
from app.repository.models import WebhookDelivery, WebhookEndpoint
from app.repository.session import get_db
from app.schemas.errors_openapi import COMMON_ERRORS, WRITE_ERRORS
from app.schemas.platform import (
    DeliveryList,
    DeliveryView,
    WebhookCreateRequest,
    WebhookCreateResponse,
    WebhookList,
    WebhookView,
)
from app.services import webhook_service

router = APIRouter(prefix="/v1", tags=["Webhooks"])


def _view(ep: WebhookEndpoint) -> WebhookView:
    return WebhookView(
        webhook_id=ep.id,
        url=ep.url,
        events=ep.events or ["*"],
        status=ep.status,
        description=ep.description,
        created_at=ep.created_at,
    )


@router.post("/webhooks", include_in_schema=False)
@router.post(
    "/webhook-endpoints",
    operation_id="createWebhook",
    summary="Register a signed webhook endpoint (secret returned once)",
    response_model=WebhookCreateResponse,
    responses=WRITE_ERRORS,
)
async def create_webhook(
    body: WebhookCreateRequest,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("validate")),
    db: Session = Depends(get_db),
) -> WebhookCreateResponse:
    webhook_service.validate_url(body.url)

    secret = webhook_service.generate_secret()
    ep = WebhookEndpoint(
        api_key_id=request.state.api_key_id,
        url=body.url,
        secret=secret,
        events=body.events or ["*"],
        description=body.description,
    )
    db.add(ep)
    db.flush()
    db.commit()

    return WebhookCreateResponse(**_view(ep).model_dump(), secret=secret)


@router.get("/webhooks", include_in_schema=False)
@router.get(
    "/webhook-endpoints",
    operation_id="listWebhooks",
    summary="List webhook endpoints (never echoes secrets)",
    response_model=WebhookList,
    responses=COMMON_ERRORS,
)
async def list_webhooks(
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> WebhookList:
    rows = (
        db.query(WebhookEndpoint)
        .filter(WebhookEndpoint.api_key_id == request.state.api_key_id)
        .order_by(WebhookEndpoint.created_at.desc())
        .all()
    )
    return WebhookList(webhooks=[_view(r) for r in rows])


@router.get("/webhooks/deliveries", include_in_schema=False)
@router.get(
    "/webhook-endpoints/deliveries",
    operation_id="listWebhookDeliveries",
    summary="Inspect delivery attempts, responses, and failures",
    response_model=DeliveryList,
    responses=COMMON_ERRORS,
)
async def list_deliveries(
    request: Request,
    status: str | None = Query(default=None, description="pending | delivered | failed"),
    operation_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> DeliveryList:
    q = db.query(WebhookDelivery).filter(
        WebhookDelivery.api_key_id == request.state.api_key_id
    )
    if status:
        q = q.filter(WebhookDelivery.status == status)
    if operation_id:
        q = q.filter(WebhookDelivery.operation_id == operation_id)
    rows = q.order_by(WebhookDelivery.created_at.desc()).limit(limit).all()

    return DeliveryList(
        deliveries=[
            DeliveryView(
                delivery_id=r.id,
                endpoint_id=r.endpoint_id,
                operation_id=r.operation_id,
                event_type=r.event_type,
                status=r.status,
                attempts=r.attempts,
                response_status=r.response_status,
                last_error=r.last_error,
                created_at=r.created_at,
                delivered_at=r.delivered_at,
            )
            for r in rows
        ]
    )


# Ordering note: the static `/webhooks/deliveries` route is declared BEFORE any `/webhooks/{id}`
# route so FastAPI matches it literally rather than capturing "deliveries" as an id — the same trap
# documented in routers/strategies.py. Keep new static sub-paths above this line.
@router.delete("/webhooks/{id}", include_in_schema=False)
@router.delete(
    "/webhook-endpoints/{id}",
    operation_id="deleteWebhook",
    summary="Disable a webhook endpoint",
    responses=WRITE_ERRORS,
)
async def delete_webhook(
    id: str,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("validate")),
    db: Session = Depends(get_db),
):
    ep = webhook_service.get_owned(db, id, request.state.api_key_id)
    ep.status = "disabled"
    db.flush()
    db.commit()
    return {"webhook_id": ep.id, "status": ep.status}


@router.post("/webhooks/{id}/rotate", include_in_schema=False)
@router.post(
    "/webhook-endpoints/{id}/rotate",
    operation_id="rotateWebhookSecret",
    summary="Rotate the signing secret (new secret returned once)",
    response_model=WebhookCreateResponse,
    responses=WRITE_ERRORS,
)
async def rotate_secret(
    id: str,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("validate")),
    db: Session = Depends(get_db),
) -> WebhookCreateResponse:
    ep = webhook_service.get_owned(db, id, request.state.api_key_id)
    secret = webhook_service.generate_secret()
    ep.secret = secret
    db.flush()
    db.commit()
    return WebhookCreateResponse(**_view(ep).model_dump(), secret=secret)
