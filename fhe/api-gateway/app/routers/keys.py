"""Self-serve API keys: list packs, purchase with wallet USDC, list keys for a wallet."""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.config import get_settings
from app.deps.idempotency import idempotent, request_scope
from app.deps.wallet_sig import verify_wallet_intent, verify_wallet_sig
from app.deps.api_key import verify_api_key
from app.errors import BadRequest, Conflict
from app.repository.models import ApiKey
from app.repository.session import get_db
from app.schemas.errors_openapi import COMMON_ERRORS
from app.schemas.keys import (
    DevnetKeyRequest,
    DevnetKeyResponse,
    KeysListResponse,
    KeySummary,
    PacksResponse,
    PurchaseRequest,
    PurchaseResponse,
)
from app.services import key_purchase
from app.services import api_key_service, key_delivery
from app.services.key_purchase import USDC_BY_CHAIN

router = APIRouter(prefix="/v1/keys", tags=["API Keys"])

# There is deliberately no long-lived plaintext recovery path. Keys are stored as HMAC hashes. A
# purchase's idempotency record may carry an AES-GCM envelope that only the pending
# browser delivery key plus a fresh wallet intent can open; plaintext is never written to disk.


@router.get(
    "/packs",
    operation_id="listCreditPacks",
    summary="List USDC credit packs for self-serve API key purchase",
    response_model=PacksResponse,
)
async def get_packs() -> PacksResponse:
    return PacksResponse(
        packs=key_purchase.list_packs(),
        collector=key_purchase.collector_address(),
        usdc_by_chain={str(k): v for k, v in USDC_BY_CHAIN.items()},
        min_custom_usdc_minor=key_purchase.MIN_CUSTOM_USDC_MINOR,
    )


@router.get(
    "",
    operation_id="listApiKeys",
    summary="List API keys owned by the signed wallet (no plaintext secrets)",
    response_model=KeysListResponse,
    responses=COMMON_ERRORS,
)
async def list_keys(
    wallet: str = Depends(verify_wallet_sig),
    db: Session = Depends(get_db),
) -> KeysListResponse:
    return KeysListResponse(
        keys=[KeySummary(**k) for k in key_purchase.list_keys_for_wallet(db, wallet)],
        collector=key_purchase.collector_address(),
    )


@router.post(
    "/purchase",
    operation_id="purchaseApiKey",
    summary="Pay USDC from wallet, mint an API key, credit prepaid balance 1:1",
    response_model=PurchaseResponse,
    responses=COMMON_ERRORS,
)
async def purchase(
    body: PurchaseRequest,
    request: Request,
    wallet: str = Depends(verify_wallet_intent),
    db: Session = Depends(get_db),
) -> PurchaseResponse:
    request_id = getattr(request.state, "request_id", "req_unknown")
    idem_key = request.headers.get("Idempotency-Key")
    if not idem_key:
        raise BadRequest("Idempotency-Key is required for API-key purchase.")
    delivery_key = key_delivery.parse_delivery_key(
        request.headers.get("X-Delivery-Key", ""), body.delivery_key_sha256
    )
    settings = get_settings()
    test = settings.api_key_pepper.startswith("dev-")  # local pepper → sk_test_

    with idempotent(db, idem_key, body.model_dump(), scope=request_scope(request, wallet=wallet)) as ctx:
        if ctx.stored is not None:
            _status_code, stored = ctx.stored
            api_key_id = str(stored.get("api_key_id", ""))
            raw = key_delivery.open_envelope(
                str(stored.get("api_key_envelope", "")),
                delivery_key,
                api_key_id=api_key_id,
            )
            resolved = api_key_service.resolve_api_key(db, raw)
            if resolved is None or resolved.id != api_key_id or resolved.integrator_id != wallet:
                raise Conflict("The completed API-key purchase no longer resolves to an active key.")
            response = {k: v for k, v in stored.items() if k not in {"completed", "api_key_envelope"}}
            return PurchaseResponse(api_key=raw, **response)

        res = key_purchase.purchase_key(
            db,
            wallet=wallet,
            chain_id=body.chain_id,
            pack_id=body.pack_id,
            tx_hash=body.tx_hash,
            request_id=request_id,
            test=test,
            usdc_minor=body.usdc_minor,
        )
        stored = {k: v for k, v in res.items() if k != "api_key"}
        stored["completed"] = True
        stored["api_key_envelope"] = key_delivery.seal(
            res["api_key"], delivery_key, api_key_id=res["api_key_id"]
        )
        ctx.store(200, stored)
        db.commit()
        return PurchaseResponse(**res)


DEVNET_PLAN = "devnet"
DEVNET_CLAIMS_PER_HOUR = 5


@router.post(
    "/devnet",
    operation_id="claimDevnetKey",
    summary="Claim a free Solana Devnet API key with a Solana wallet signature (chain 900002 only)",
    response_model=DevnetKeyResponse,
    responses=COMMON_ERRORS,
)
async def claim_devnet_key(
    body: DevnetKeyRequest,
    request: Request,
    wallet: str = Depends(verify_wallet_intent),
    db: Session = Depends(get_db),
) -> DevnetKeyResponse:
    """One active Devnet key per Solana wallet. Claiming again revokes the old key, so a lost key is
    never a lockout. The key moves nothing by itself: every fund move still needs the wallet."""
    from app.errors import Forbidden, RateLimited
    from app.deps.rate_limit import TokenBucket
    from app.repository.redis_client import get_redis
    from app.reuse import is_solana_address
    from app.services.solana_devnet import CHAIN_ID

    if not get_settings().devnet_keys_enabled:
        raise Forbidden("Free Devnet keys are not available right now.")
    if body.chain_id != CHAIN_ID or not is_solana_address(wallet):
        raise BadRequest("Free Devnet keys are for Solana wallets on chain_id 900002; sign with the Solana wallet.")
    idem_key = request.headers.get("Idempotency-Key")
    if not idem_key:
        raise BadRequest("Idempotency-Key is required to claim a Devnet key.")
    delivery_key = key_delivery.parse_delivery_key(request.headers.get("X-Delivery-Key", ""), body.delivery_key_sha256)

    with idempotent(db, idem_key, body.model_dump(), scope=request_scope(request, wallet=wallet)) as ctx:
        if ctx.stored is not None:
            stored = ctx.stored[1]
            raw = key_delivery.open_envelope(str(stored.get("api_key_envelope", "")), delivery_key,
                                             api_key_id=str(stored.get("api_key_id", "")))
            if api_key_service.resolve_api_key(db, raw) is None:
                raise Conflict("That Devnet key was revoked by a later claim; claim again with a new Idempotency-Key.")
            return DevnetKeyResponse(api_key=raw, **{k: v for k, v in stored.items() if k != "api_key_envelope"})
        # Caddy replaces any client X-Forwarded-For, so its first hop is the caller.
        ip = (request.headers.get("x-forwarded-for", "").split(",")[0].strip()
              or (request.client.host if request.client else "unknown"))
        bucket = TokenBucket(get_redis(), capacity=DEVNET_CLAIMS_PER_HOUR, refill_per_min=0, window_seconds=3600)
        if not await bucket.allow(f"devnetkey:{ip}"):
            raise RateLimited(retry_after=bucket.retry_after(f"devnetkey:{ip}"),
                              detail="Too many Devnet key claims from this address; try again later.")
        previous = db.query(ApiKey).filter(
            ApiKey.integrator_id == wallet, ApiKey.plan == DEVNET_PLAN, ApiKey.status == "active"
        ).all()
        for row in previous:
            row.status = "revoked"
        raw, row = api_key_service.mint_key(db, integrator_id=wallet, plan=DEVNET_PLAN)
        response = {"api_key_id": row.id, "plan": DEVNET_PLAN, "chain_ids": [CHAIN_ID], "revoked_previous": len(previous)}
        ctx.store(200, {**response, "api_key_envelope": key_delivery.seal(raw, delivery_key, api_key_id=row.id)})
        db.commit()
        return DevnetKeyResponse(api_key=raw, **response)


@router.get(
    "/verify",
    operation_id="verifyApiKey",
    summary="Validate Authorization Bearer API key (used by trade-executor createStrategy gate)",
    responses=COMMON_ERRORS,
)
async def verify_key(key: ApiKey = Depends(verify_api_key)):
    """Deny-by-default key check for executor / MCP hard gate. Never echoes the raw key."""
    return {
        "ok": True,
        "api_key_id": key.id,
        "plan": key.plan,
        "status": key.status,
        "integrator_id": key.integrator_id,
    }
