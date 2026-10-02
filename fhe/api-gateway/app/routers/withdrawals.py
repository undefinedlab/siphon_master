from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from web3 import Web3

from app.adapters.executor import ExecutorClient
from app.deps.api_key import verify_api_key
from app.deps.rate_limit import rate_limit
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox
from app.deps.clients import get_executor_client
from app.repository.session import get_db
from app.deps.idempotency import idempotent, request_scope, scoped_idempotency_key
from app.schemas.errors_openapi import WRITE_ERRORS
from app.schemas.notes import (
    WithdrawalRequest,
    WithdrawalResponse,
    WithdrawalConfirmationRequest,
)
from app.schemas.compliance import BusinessOperationState as S
from app.services import metering, operation_service, sandbox
from app.errors import BadRequest, Conflict, DownstreamUnavailable, Forbidden, NotFound

router = APIRouter(prefix="/v1", tags=["Pool"])


def _wallet_headers(request: Request, relay_id: str) -> dict[str, str]:
    """Forward the user's auth headers to the executor's (write-challenge gated) user routes."""
    keys = ("X-Wallet-Address", "X-Signature", "X-Timestamp", "X-Write-Signature", "X-Write-Nonce")
    headers = {k: request.headers[k] for k in keys if k in request.headers}
    headers["X-Relay-Id"] = relay_id
    return headers


@router.post(
    "/withdrawals",
    operation_id="createWithdrawal",
    summary="Create a withdrawal intent (proof + calldata; sanctions-screened, fail-closed)",
    response_model=WithdrawalResponse,
    responses=WRITE_ERRORS,
)
async def create_withdrawal(
    request: Request,
    body: WithdrawalRequest,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
    executor: ExecutorClient = Depends(get_executor_client),
    db: Session = Depends(get_db),
) -> WithdrawalResponse:
    sandbox.apply_scenario(request)
    # 1. Screen sanctions (fail-closed)
    from app.services.sanctions import screen_address
    if not sandbox.is_sandbox_request(request):
        screen_address(wallet, body.chain_id)
        screen_address(body.recipient, body.chain_id)

    idem_key = request.headers.get("Idempotency-Key")
    if not idem_key:
        raise BadRequest("Idempotency-Key is required for withdrawals.")
    scope = request_scope(request, wallet=wallet)
    relay_id = scoped_idempotency_key(scope, idem_key)
    with idempotent(db, idem_key, body.model_dump(), scope=scope) as ctx:
        if ctx.stored is not None:
            status_code, resp_body = ctx.stored
            if status_code >= 400:
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=status_code, content=resp_body)
            return WithdrawalResponse(**resp_body)

        relay_body = body.model_dump()
        op = operation_service.create(
            db,
            api_key_id=request.state.api_key_id,
            kind="withdrawal",
            chain_id=body.chain_id,
            asset=body.asset.upper(),
            recipient=body.recipient,
            wallet=wallet,
            state=S.authorized,
            detail={"relay_id": relay_id},
        )

        # 2. Relay withdrawal. The executor lease is acknowledged before the gateway commits the
        # authorized operation, closing the queued-request ambiguity and enabling worker recovery.
        if sandbox.is_sandbox_request(request):
            tx_hash = sandbox.fake_tx_hash("withdrawal", relay_id)
        else:
            executor.prepare_relay_submission(relay_id, relay_body, wallet=wallet)
            db.commit()
            try:
                res = executor.relay_withdraw(
                    relay_body, wallet_headers=_wallet_headers(request, relay_id)
                )
            except Exception as e:
                from app.errors import GatewayError
                if isinstance(e, GatewayError):
                    raise
                raise DownstreamUnavailable(f"Executor relayWithdraw failed: {e}")
            tx_hash = res.get("tx_hash")
        operation_service.transition(db, op, S.submitted, tx_hash=tx_hash)
        ret_val = WithdrawalResponse(
            status="submitted",
            tx_hash=tx_hash
        )

        # Bind the tx to this caller (internal state; NOT part of the response) so confirmation can
        # verify ownership via an indexed tx_hash lookup.
        from app.services import tx_binding
        tx_binding.bind(db, tx_hash=tx_hash, wallet=wallet,
                        api_key_id=request.state.api_key_id, chain_id=body.chain_id, kind="withdrawal")

        ctx.store(200, ret_val.model_dump())
        db.commit()
        return ret_val


@router.post(
    "/withdrawals/{id}/confirmation",
    operation_id="confirmWithdrawal",
    summary="Confirm a mined withdrawal -> nullifiers spent (metering point)",
    responses=WRITE_ERRORS,
)
async def confirm_withdrawal(
    id: str,
    body: WithdrawalConfirmationRequest,
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
    db: Session = Depends(get_db),
):
    # 1. Bind check: indexed lookup of the tx -> owner binding recorded at create time (BOLA).
    from app.services import tx_binding
    binding = tx_binding.lookup(db, body.tx_hash)
    # 404 (never confirm existence) if unknown OR not this wallet's tx.
    if binding is None or binding.wallet.lower() != wallet.lower():
        raise NotFound("Transaction was not created by this gateway or is invalid.")
    if binding.api_key_id != request.state.api_key_id:
        raise Forbidden("Transaction is not associated with your API key.")

    # 2. Find the transaction and determine chain_id. Sandbox receipts are deterministic and never
    # touch RPC or sanctions infrastructure, while ownership/metering still use the real database.
    from app.services.confirmations import find_tx_chain_and_receipt, is_confirmed
    if sandbox.is_sandbox_request(request):
        chain_id = binding.chain_id
        receipt = sandbox.fake_receipt(chain_id, body.tx_hash)
    else:
        res = find_tx_chain_and_receipt(body.tx_hash)
        if not res:
            raise Conflict("Transaction receipt not found on any supported chain.")
        chain_id, receipt = res
        from app.services.sanctions import screen_address

        screen_address(wallet, chain_id)

    # 4. Check transaction status
    if receipt.get("status") != 1:
        raise Conflict("Withdrawal transaction failed on-chain.")

    # 5. Check block confirmation depth
    if not sandbox.is_sandbox_request(request) and not is_confirmed(chain_id, body.tx_hash):
        raise Conflict("Transaction has not reached the required block confirmation threshold.")

    # 6. Meter the withdrawal (creates UsageEvent)
    request_id = getattr(request.state, "request_id", "req_unknown")
    metering.record(
        db,
        api_key_id=request.state.api_key_id,
        event_type="withdrawal",
        tx_hash=body.tx_hash,
        request_id=request_id
    )
    db.commit()

    return {"withdrawal_id": id, "status": "confirmed"}
