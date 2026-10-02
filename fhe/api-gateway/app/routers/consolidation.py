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
    ConsolidationRequest,
    ConsolidationResponse,
    ConsolidationConfirmationRequest,
)
from app.errors import BadRequest, Conflict, DownstreamUnavailable, Forbidden, NotFound
from app.schemas.compliance import BusinessOperationState as S
from app.services import operation_service, sandbox

router = APIRouter(prefix="/v1", tags=["Pool"])


def _wallet_headers(request: Request, relay_id: str) -> dict[str, str]:
    """Forward the user's auth headers to the executor's (write-challenge gated) user routes."""
    keys = ("X-Wallet-Address", "X-Signature", "X-Timestamp", "X-Write-Signature", "X-Write-Nonce")
    headers = {k: request.headers[k] for k in keys if k in request.headers}
    headers["X-Relay-Id"] = relay_id
    return headers


@router.post(
    "/notes/consolidation",
    operation_id="createConsolidation",
    summary="Create a merge intent (2..6 input notes -> 1 merged note)",
    response_model=ConsolidationResponse,
    responses=WRITE_ERRORS,
)
async def create_consolidation(
    request: Request,
    body: ConsolidationRequest,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
    executor: ExecutorClient = Depends(get_executor_client),
    db: Session = Depends(get_db),
) -> ConsolidationResponse:
    sandbox.apply_scenario(request)
    # 1. Enforce N <= 6 cap on input commitments (N is length of nullifierHashes)
    nullifiers = body.proof.nullifierHashes
    if len(nullifiers) > 6:
        raise BadRequest("Cannot consolidate more than 6 notes at once (N <= 6 cap).")
    if len(nullifiers) < 2:
        raise BadRequest("Must consolidate at least 2 notes.")

    # 2. Screen sanctions (fail-closed) BEFORE relaying — a merge is a fund-moving write path, so a
    # sanctioned wallet must be blocked here, not only at confirm (by then the tx is already on-chain).
    from app.services.sanctions import screen_address
    if not sandbox.is_sandbox_request(request):
        screen_address(wallet, body.chain_id)

    idem_key = request.headers.get("Idempotency-Key")
    if not idem_key:
        raise BadRequest("Idempotency-Key is required for consolidation.")
    scope = request_scope(request, wallet=wallet)
    relay_id = scoped_idempotency_key(scope, idem_key)
    with idempotent(db, idem_key, body.model_dump(), scope=scope) as ctx:
        if ctx.stored is not None:
            status_code, resp_body = ctx.stored
            if status_code >= 400:
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=status_code, content=resp_body)
            return ConsolidationResponse(**resp_body)

        relay_body = body.model_dump()
        op = operation_service.create(
            db,
            api_key_id=request.state.api_key_id,
            kind="consolidation",
            chain_id=body.chain_id,
            asset=body.asset.upper(),
            wallet=wallet,
            state=S.authorized,
            detail={"relay_id": relay_id},
        )

        # 3. Relay merge through the same durable lease/journal protocol as withdrawals.
        if sandbox.is_sandbox_request(request):
            tx_hash = sandbox.fake_tx_hash("consolidation", relay_id)
        else:
            executor.prepare_relay_submission(relay_id, relay_body, wallet=wallet)
            db.commit()
            try:
                res = executor.relay_merge(
                    relay_body, wallet_headers=_wallet_headers(request, relay_id)
                )
            except Exception as e:
                from app.errors import GatewayError
                if isinstance(e, GatewayError):
                    raise
                raise DownstreamUnavailable(f"Executor relayMerge failed: {e}")
            tx_hash = res.get("tx_hash")
        operation_service.transition(db, op, S.submitted, tx_hash=tx_hash)
        ret_val = ConsolidationResponse(
            status="submitted",
            tx_hash=tx_hash
        )

        # Bind the tx to this caller (internal state; NOT part of the response) so confirmation can
        # verify ownership via an indexed tx_hash lookup.
        from app.services import tx_binding
        tx_binding.bind(db, tx_hash=tx_hash, wallet=wallet,
                        api_key_id=request.state.api_key_id, chain_id=body.chain_id, kind="consolidation")

        ctx.store(200, ret_val.model_dump())
        db.commit()
        return ret_val


@router.post(
    "/notes/consolidation/{id}/confirmation",
    operation_id="confirmConsolidation",
    summary="Confirm a mined merge -> N inputs spent, 1 merged note spendable",
    responses=WRITE_ERRORS,
)
async def confirm_consolidation(
    id: str,
    body: ConsolidationConfirmationRequest,
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
    db: Session = Depends(get_db),
):
    # 1. Bind check: indexed lookup of the tx -> owner binding recorded at create time (BOLA).
    from app.services import tx_binding
    binding = tx_binding.lookup(db, body.tx_hash)
    if binding is None or binding.wallet.lower() != wallet.lower():
        raise NotFound("Transaction was not created by this gateway or is invalid.")
    if binding.api_key_id != request.state.api_key_id:
        raise Forbidden("Transaction is not associated with your API key.")

    # 2. Find the transaction and determine chain_id; sandbox completes against a deterministic
    # receipt without reaching RPC or sanctions infrastructure.
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
        raise Conflict("Merge transaction failed on-chain.")

    # 5. Check block confirmation depth
    if not sandbox.is_sandbox_request(request) and not is_confirmed(chain_id, body.tx_hash):
        raise Conflict("Transaction has not reached the required block confirmation threshold.")

    return {"consolidation_id": id, "status": "confirmed"}
