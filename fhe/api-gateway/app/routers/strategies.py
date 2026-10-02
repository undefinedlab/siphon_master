"""Confidential strategies — discovery, validate, create/arm, list/get, abort.

Stubs for the v1 contract; real logic lands in the strategy tasks. Ordering note: the static
routes (`/strategies/functions`, `/strategies/validate`) are declared before `/strategies/{id}`
so FastAPI matches them literally rather than as an `{id}` capture.
"""
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.adapters.executor import ExecutorClient
from app.deps.api_key import verify_api_key
from app.deps.authz import require_owner
from app.deps.clients import get_executor_client
from app.deps.rate_limit import rate_limit
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox, verify_wallet_sig_or_sandbox
from app.repository.session import get_db
from app.deps.idempotency import idempotent, request_scope
from app.schemas.errors_openapi import COMMON_ERRORS, WRITE_ERRORS
from app.schemas.strategies import (
    StrategyFunctions,
    StrategyList,
    StrategyReproveRequest,
    StrategyValidateRequest,
    StrategyValidateResponse,
    StrategyView,
)
from app.services import strategy_service, billing_ref, metering, sandbox
from app.errors import BadRequest, FheKeysMissing, DownstreamUnavailable, Forbidden



def _wallet_headers(request: Request) -> dict[str, str]:
    """Forward the user's auth headers to the executor's (write-challenge gated) user routes."""
    keys = (
        "X-Wallet-Address",
        "X-Signature",
        "X-Timestamp",
        "X-Nonce",
        "X-Write-Signature",
        "X-Write-Nonce",
        "Authorization",
    )
    return {k: request.headers[k] for k in keys if k in request.headers}


def _solana_executor(wallet: str) -> tuple[ExecutorClient, dict[str, str]] | None:
    """Solana Devnet orders live on the chain-900002 executor. The gateway has verified the wallet
    (ed25519 intent or read signature); the executor accepts that only with the gateway attestation."""
    from app.reuse import is_solana_address
    from app.services.v5_chains import executor

    if not is_solana_address(wallet):
        return None
    client = executor(900002)
    return client, {"X-Wallet-Address": wallet, "X-Siphon-Gateway-Token": client._api_token or ""}


def _to_view(row: dict) -> StrategyView:
    return StrategyView(
        id=row["id"],
        strategy_type=row.get("strategy_type"),
        asset_in=row.get("asset_in"),
        asset_out=row.get("asset_out"),
        amount=row.get("amount"),
        status=strategy_service.lifecycle_status(row.get("status")),
        tx_hash=row.get("tx_hash"),
        executed_at=row.get("executed_at"),
        created_at=row.get("created_at"),
        vault_generation_id=row.get("vault_generation_id"),
        from_chain=str(row["from_chain"]) if row.get("from_chain") is not None else None,
        execution_error=row.get("execution_error"),
        settlement=row.get("settlement"),
        legs=row.get("legs"),
    )


def _enforce_strategy_generation(body: dict) -> None:
    from app.services.vault_generation import validate_strategy_generation, rejection_message
    from app.errors import (
        VaultExitOnly,
        VaultGenerationNotActive,
        VaultGenerationRequired,
        VaultGenerationUnavailable,
    )

    try:
        chain_id = int(body.get("from_chain", body.get("chain_id")))
    except (TypeError, ValueError):
        raise VaultGenerationUnavailable("A valid strategy source chain is required.")
    decision = validate_strategy_generation(chain_id, body.get("vault_generation_id"))
    if decision["valid"]:
        return
    code = decision["code"]
    exc = {
        "VAULT_EXIT_ONLY": VaultExitOnly,
        "VAULT_GENERATION_REQUIRED": VaultGenerationRequired,
        "VAULT_GENERATION_NOT_ACTIVE": VaultGenerationNotActive,
        "VAULT_GENERATION_UNAVAILABLE": VaultGenerationUnavailable,
    }[code]
    raise exc(rejection_message(code))

router = APIRouter(prefix="/v1", tags=["Strategies"])


@router.get(
    "/strategies/functions",
    operation_id="listStrategyFunctions",
    summary="Catalog of strategy types + params (agent discovery)",
    response_model=StrategyFunctions,
    responses=COMMON_ERRORS,
)
async def list_strategy_functions(
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
) -> StrategyFunctions:
    return StrategyFunctions(**strategy_service.functions_catalog())


@router.post(
    "/strategies/validate",
    operation_id="validateStrategy",
    summary="Dry-run validity (semantic + crypto); free, unmetered",
    response_model=StrategyValidateResponse,
    # Read-class: a dry-run moves no funds and is unmetered — no 402/409/422-reuse/451.
    responses=COMMON_ERRORS,
)
async def validate_strategy(
    body: StrategyValidateRequest,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("validate")),
) -> StrategyValidateResponse:
    # Free, unmetered: semantic/shape checks only. No executor call, no usage_event.
    return StrategyValidateResponse(**strategy_service.validate(body.model_dump()))


@router.post(
    "/strategies",
    operation_id="createStrategy",
    summary="Create + arm a confidential strategy (metered strategy_created)",
    response_model=StrategyView,
    responses=WRITE_ERRORS,
)
async def create_strategy(
    request: Request,
    body: dict,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
    executor: ExecutorClient = Depends(get_executor_client),
    db: Session = Depends(get_db),
) -> StrategyView:
    idem_key = request.headers.get("Idempotency-Key")
    if not idem_key:
        raise BadRequest("Idempotency-Key is required for strategy creation.")
    request_id = getattr(request.state, "request_id", "req_unknown")
    sandbox.apply_scenario(request)

    with idempotent(db, idem_key, body, scope=request_scope(request, wallet=wallet)) as ctx:
        if ctx.stored is not None:
            status_code, resp_body = ctx.stored
            if status_code >= 400:
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=status_code, content=resp_body)
            return StrategyView(**resp_body)


        wallet_headers = _wallet_headers(request)
        from app.services import solana_devnet
        from app.services.v5_chains import devnet_only

        solana = solana_devnet.is_solana(body.get("from_chain", body.get("chain_id")))
        if devnet_only(request) and not solana:
            raise Forbidden("This is a free Solana Devnet key; strategies need from_chain 900002.")
        if solana:
            routed = _solana_executor(wallet)
            if routed is None:
                raise BadRequest("Solana Devnet strategies are signed by the Solana wallet that owns the notes.")
            executor, solana_headers = routed
            wallet_headers = {**wallet_headers, **solana_headers}
        if sandbox.is_sandbox_request(request):
            # No generation gate here on purpose: a sandbox strategy is a deterministic fixture that
            # never reaches a vault, an executor or a chain, so binding it to a live generation only
            # made `sk_test_` keys fail wherever a real one happened to be unconfigured.
            strategy_id = "sandbox_" + sandbox.fake_tx_hash("strategy", idem_key)[2:26]
        else:
            # Bind the strategy to the active vault generation before any executor call. Solana
            # Devnet has no EVM vault generation; the executor validates its spend package instead.
            if not solana:
                _enforce_strategy_generation(body)

            # 1. Check FHE keys over an internal authenticated service route.
            try:
                has_key_res = executor.has_server_key(wallet, wallet_headers=wallet_headers)
            except Exception as e:
                from app.errors import GatewayError
                if isinstance(e, GatewayError):
                    raise
                raise DownstreamUnavailable(f"Failed to check FHE keys: {e}")

            if not (has_key_res.get("has_key") or has_key_res.get("hasKey")):
                raise FheKeysMissing(
                    "No FHE server key on file for this user. Upload it via /uploadServerKey first."
                )

            payload = dict(body)
            payload["user_id"] = wallet
            payload["billing_ref"] = billing_ref.sign(request.state.api_key_id)
            db.commit()
            try:
                res = executor.create_strategy(payload, wallet_headers=wallet_headers)
            except Exception as e:
                from app.errors import GatewayError
                if isinstance(e, GatewayError):
                    raise
                raise DownstreamUnavailable(f"Executor createStrategy failed: {e}")
            strategy_id = res.get("strategy_id")
        
        # 4. Record metering
        metering.record(
            db,
            api_key_id=request.state.api_key_id,
            event_type="strategy_created",
            strategy_id=strategy_id,
            request_id=request_id
        )

        view = StrategyView(
            id=strategy_id,
            strategy_type=body.get("strategy_type"),
            asset_in=body.get("asset_in"),
            asset_out=body.get("asset_out"),
            amount=body.get("amount"),
            status="armed",
            created_at=datetime.now(timezone.utc).isoformat(),
            vault_generation_id=body.get("vault_generation_id"),
        )

        ctx.store(200, view.model_dump())
        db.commit()
        return view



@router.get(
    "/strategies",
    operation_id="listStrategies",
    summary="List my strategies (owner-scoped)",
    response_model=StrategyList,
    responses=COMMON_ERRORS,
)
async def list_strategies(
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_sig_or_sandbox),
    _rl=Depends(rate_limit("read")),
    executor: ExecutorClient = Depends(get_executor_client),
) -> StrategyList:
    if sandbox.is_sandbox_request(request):
        return StrategyList(strategies=[])
    headers = _wallet_headers(request)
    routed = _solana_executor(wallet)
    if routed:
        executor, headers = routed
    # Owner-scoped by construction: the executor lists strategies for this authed wallet as user_id.
    data = executor.list_strategies(wallet, wallet_headers=headers)
    return StrategyList(strategies=[_to_view(s) for s in data.get("strategies", [])])


@router.get(
    "/strategies/{id}",
    operation_id="getStrategy",
    summary="Get one strategy + result/attestation (owner-scoped; 404 if not owner)",
    response_model=StrategyView,
    responses=COMMON_ERRORS,
)
async def get_strategy(
    id: str,
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_sig_or_sandbox),
    _rl=Depends(rate_limit("read")),
    executor: ExecutorClient = Depends(get_executor_client),
) -> StrategyView:
    if sandbox.is_sandbox_request(request):
        return StrategyView(id=id, status="armed", created_at=datetime.now(timezone.utc).isoformat())
    routed = _solana_executor(wallet)
    if routed:
        # The owner's list carries the Devnet settlement record (the returned note); the result
        # route does not. Not in the list → not this wallet's → 404.
        sol_executor, headers = routed
        rows = sol_executor.list_strategies(wallet, wallet_headers=headers).get("strategies", [])
        match = next((r for r in rows if str(r.get("id")) == str(id)), None)
        if match is None:
            from app.errors import NotFound

            raise NotFound("Resource not found.")
        return _to_view(match)
    row = executor.get_strategy_result(id, wallet_headers=_wallet_headers(request))
    # BOLA: the strategy's owner must equal the authed wallet, else 404 (never confirm existence).
    require_owner(row.get("user_id"), wallet)
    return _to_view(row)


@router.post(
    "/strategies/{id}/abort",
    operation_id="abortStrategy",
    summary="Abort unfired legs, reclaim funds (owner-scoped; not metered)",
    responses=WRITE_ERRORS,
)
async def abort_strategy(
    id: str,
    request: Request,
    _key=Depends(verify_api_key),
    _wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
    executor: ExecutorClient = Depends(get_executor_client),
):
    sandbox.apply_scenario(request)
    if sandbox.is_sandbox_request(request):
        return {"strategy_id": id, "status": "aborted"}
    headers = _wallet_headers(request)
    routed = _solana_executor(_wallet)
    if routed:
        executor, headers = routed
    try:
        return executor.abort_strategy(id, wallet_headers=headers)
    except Exception as e:
        from app.errors import Forbidden, GatewayError, NotFound
        # BOLA (§3.5): the executor returns 403 for a non-owner, which confirms the strategy exists.
        # Re-raise as 404 so abort matches every other owner-scoped route (never confirm existence).
        if isinstance(e, Forbidden):
            raise NotFound("Resource not found.")
        if isinstance(e, GatewayError):
            raise
        raise DownstreamUnavailable(f"Executor abort_strategy failed: {e}")


@router.post(
    "/strategies/{id}/reprove",
    operation_id="reproveStrategy",
    summary="Solana Devnet: replace a resting order's (or leg's) spend proof after the roots moved",
    responses=WRITE_ERRORS,
)
async def reprove_strategy(
    id: str,
    body: StrategyReproveRequest,
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
):
    """A Devnet order whose settlement says `waiting: NEEDS_REPROOF` cites roots the program no longer
    accepts. Prove the same note again against current roots and send the package here; the order
    keeps its trigger and fires on its own."""
    if sandbox.is_sandbox_request(request):
        return {"status": "refreshed", "strategy_id": id}
    routed = _solana_executor(wallet)
    if routed is None:
        raise BadRequest("Re-proving is for Solana Devnet orders, signed by the owning Solana wallet.")
    executor, headers = routed
    payload = {"strategy_id": id, "user_id": wallet, "zkp_data": body.zkp_data, "refresh_only": True}
    if body.leg_index is not None:
        payload["leg_index"] = body.leg_index
    try:
        return executor._request("POST", "/executeStrategy", json=payload, headers=headers)
    except Forbidden:
        from app.errors import NotFound

        raise NotFound("Resource not found.")
