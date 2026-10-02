"""Proof-bound payouts that return an unsigned transaction to the account wallet."""
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.deps.api_key import verify_api_key
from app.deps.idempotency import idempotent, request_scope, scoped_idempotency_key
from app.deps.rate_limit import rate_limit
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox
from app.errors import BadRequest, Conflict, DownstreamUnavailable, Forbidden, GatewayError
from app.repository.session import get_db
from app.schemas.business import PayoutRequest, PayoutResponse, SplitRequest, SplitResponse, WalletChallengeResponse
from app.schemas.errors_openapi import WRITE_ERRORS
from app.schemas.platform import OperationView
from app.schemas.compliance import BusinessOperationState as S
from app.services import (
    operation_service,
    policy_service,
    sandbox,
    self_custody_account_service as account_service,
    subaccount_service,
    unsigned_transaction_service,
)

router = APIRouter(prefix="/v1", tags=["Payouts"])


def _relay_spend(chain_id: int, relay_body: dict, headers: dict[str, str]) -> dict:
    from app.errors import GatewayError, WithdrawCreditRequired
    from app.services.v5_chains import executor

    try:
        return executor(chain_id).relay_spend(relay_body, wallet_headers=headers)
    except GatewayError as exc:
        if exc.status == 402 or "withdraw_credit" in str(exc.detail):
            raise WithdrawCreditRequired(
                "The relayer's prepaid gas credit for this wallet is too low. Top up, or resubmit "
                "with submission_mode=unsigned and send VaultKernel.spend from any other address."
            ) from exc
        raise


def _relay_headers(request: Request, relay_id: str) -> dict[str, str]:
    names = ("X-Wallet-Address", "X-Write-Signature", "X-Write-Nonce", "X-Request-ID")
    headers = {name: request.headers[name] for name in names if name in request.headers}
    headers["X-Relay-Id"] = relay_id
    return headers


def _relay_solana_or_settle(db, op, relay_id: str | None, relay_body: dict, wallet: str, request: Request) -> str:
    """Relay a Solana Devnet spend. A refusal settles the operation now; an unknown outcome leaves it
    authorized for v5_reconcile.settle_relay to decide from the nullifier account."""
    from app.services import v5_reconcile
    from app.services.v5_chains import executor

    try:
        result = executor(op.chain_id).relay_solana(relay_body, wallet=wallet,
                                                    request_id=getattr(request.state, "request_id", None))
    except GatewayError as exc:
        if exc.status < 500:
            operation_service.transition(db, op, S.failed, error_code=exc.error_code.value)
            v5_reconcile.complete_failed_reservation(db, relay_id, exc.error_code.value)
            db.commit()
            raise
        raise DownstreamUnavailable(
            "The relayer did not confirm this spend. Its outcome will be settled from chain state; "
            f"poll GET /v1/operations/{op.id} rather than resubmitting."
        ) from exc
    sig = result.get("spend_sig")
    if not sig or sig == "unconfirmed":
        # The nullifier exists (the relayer checked) but the signature was lost: settle from chain.
        raise DownstreamUnavailable(
            f"The spend landed but its signature was not returned; poll GET /v1/operations/{op.id}."
        )
    return sig


@router.post(
    "/splits",
    operation_id="createSplit",
    summary="Split a Solana Devnet note into up to 8 slices (relayed, for multi-leg orders)",
    response_model=SplitResponse,
    responses=WRITE_ERRORS,
)
async def create_split(
    body: SplitRequest,
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
    db: Session = Depends(get_db),
) -> SplitResponse:
    from app.services import solana_devnet
    from app.services.v5_chains import access

    if not access(request, body.chain_id):
        raise BadRequest("Splits are relayed on Solana Devnet (900002) only.")
    if sandbox.is_sandbox_request(request):
        raise Forbidden("Splits move live notes; sandbox keys cannot relay them.")
    account = account_service.resolve(db, request.state.api_key_id, body.account_id)
    if not account.owner_address or account.owner_address.lower() != wallet.lower():
        raise Forbidden("The signing wallet does not control this account.")
    idem_key = request.headers.get("Idempotency-Key")
    if not idem_key:
        raise BadRequest("Idempotency-Key is required for splits.")
    scope = request_scope(request, wallet=wallet)
    relay_id = scoped_idempotency_key(scope, idem_key)
    with idempotent(db, idem_key, body.model_dump(), scope=scope) as ctx:
        if ctx.stored is not None:
            status_code, stored = ctx.stored
            if status_code >= 400:
                raise Conflict("This split already failed; the proof may still be valid — retry with a new Idempotency-Key.")
            return SplitResponse(**stored)
        package = solana_devnet.spend_package(body.solana_spend.model_dump(), split_commitments=body.split_commitments)
        op = operation_service.create(
            db,
            api_key_id=request.state.api_key_id,
            kind="split",
            subaccount_id=account.subaccount_id,
            chain_id=body.chain_id,
            asset=None,
            amount_minor=None,
            wallet=wallet,
            detail={
                "account_id": account.id,
                "protocol": "solana",
                "nullifier": package["publics"][9],
                "relay_id": relay_id,
                "relay_started_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        operation_service.transition(db, op, S.screening)
        operation_service.transition(db, op, S.ready)
        operation_service.transition(db, op, S.authorized)
        db.commit()
        tx_hash = _relay_solana_or_settle(db, op, relay_id, {"user_id": wallet, "package": package}, wallet, request)
        operation_service.transition(db, op, S.submitted, tx_hash=tx_hash)
        response = SplitResponse(operation=OperationView(**operation_service.public_view(op)), tx_hash=tx_hash)
        ctx.store(200, response.model_dump(mode="json"))
        db.commit()
        return response


@router.post(
    "/wallet-challenges",
    operation_id="createWalletChallenge",
    summary="Issue a single-use end-to-end relay authorization challenge",
    response_model=WalletChallengeResponse,
    responses=WRITE_ERRORS,
)
async def create_wallet_challenge(
    request: Request,
    chain_id: int = Query(
        default=8453,
        description="The payout's chain. Each chain's relayer issues and consumes its own nonces.",
    ),
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("validate")),
) -> WalletChallengeResponse:
    from app.services.v5_chains import chain_for, executor

    chain_for(request, chain_id)
    challenge = executor(chain_id).issue_wallet_challenge(chain_id)
    nonce = str(challenge.get("nonce") or "")
    if challenge.get("chain_id") != chain_id or not re.fullmatch(r"[0-9a-f]{16,128}", nonce):
        # An executor that ignores chain binding (pre-G-8 build) or answers for another chain.
        raise DownstreamUnavailable("The relayer did not issue a chain-bound challenge.")
    # Built here from the requested chain, never echoed from the executor's own text.
    return WalletChallengeResponse(
        nonce=nonce,
        message=f"Siphon auth v2:write:{chain_id}:{nonce}",
        expires_at=challenge.get("expires_at"),
        ttl_seconds=challenge.get("ttl_seconds"),
    )


@router.post(
    "/payouts",
    operation_id="createPayout",
    summary="Create a proof-bound unsigned private payout",
    response_model=PayoutResponse,
    responses=WRITE_ERRORS,
)
async def create_payout(
    body: PayoutRequest,
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
    db: Session = Depends(get_db),
) -> PayoutResponse:
    sandbox.apply_scenario(request)
    from app.services import solana_devnet
    from app.services.v5_chains import access

    solana = access(request, body.chain_id)
    if solana:
        if body.solana_spend is None or body.spend is not None:
            raise BadRequest("Solana Devnet payouts take `solana_spend` (not `spend`).")
        if body.submission_mode != "relay":
            raise BadRequest("Solana Devnet payouts are relayed; submission_mode must be relay.")
        solana_devnet.pubkey(body.recipient, "recipient")
    elif body.spend is None:
        raise BadRequest("EVM payouts take the v5 `spend` bundle.")
    account = account_service.resolve(db, request.state.api_key_id, body.account_id)
    if not account.owner_address or account.owner_address.lower() != wallet.lower():
        raise Forbidden("The signing wallet does not control this account.")

    if not sandbox.is_sandbox_request(request):
        from app.services.sanctions import screen_address

        screen_address(wallet, body.chain_id)
        screen_address(body.recipient, body.chain_id)
    pool = sandbox.fake_pool_state(body.chain_id, body.asset) if sandbox.is_sandbox_request(request) else {}
    policy_version = policy_service.enforce(
        db,
        api_key_id=request.state.api_key_id,
        chain_id=body.chain_id,
        asset=body.asset,
        amount_minor=body.amount_minor,
        recipient=body.recipient,
        anonymity_set=pool.get("anonymity_set"),
        asp_root_stale=pool.get("asp_root_stale"),
        subaccount_id=account.subaccount_id,
    )
    sub = (
        subaccount_service.get_owned(db, account.subaccount_id, request.state.api_key_id)
        if account.subaccount_id
        else None
    )
    subaccount_service.assert_can_spend(db, sub, body.amount_minor)

    idem_key = request.headers.get("Idempotency-Key")
    if body.submission_mode == "relay" and not idem_key:
        raise BadRequest("Idempotency-Key is required for relayed payouts.")
    scope = request_scope(request, wallet=wallet)
    relay_id = scoped_idempotency_key(scope, idem_key) if idem_key else None

    with idempotent(
        db,
        idem_key,
        body.model_dump(),
        scope=scope,
    ) as ctx:
        if ctx.stored is not None:
            status_code, stored = ctx.stored
            if status_code >= 400:
                # A settled failure under this key (relayer refused, or the spend never landed).
                raise Conflict(
                    f"This payout already failed ({(stored or {}).get('error_code', 'relay_failed')}); "
                    "the proof is still valid — retry with a new Idempotency-Key."
                )
            return PayoutResponse(**stored)
        from app.services.v5_chains import chain as v5_chain

        if solana:
            package = solana_devnet.spend_package(
                body.solana_spend.model_dump(), asset=body.asset, amount_minor=body.amount_minor
            )
            spend = {"public_inputs": package["publics"]}
            transaction = {"to": str(solana_devnet.program_id()), "data": "0x" + package["proof_hex"]}
        else:
            spend = body.spend.model_dump()
            unsigned_transaction_service.validate_withdraw_bundle(
                v5_chain(body.chain_id), spend, asset=body.asset, amount_minor=body.amount_minor, recipient=body.recipient
            )
            transaction = unsigned_transaction_service.spend_transaction(body.chain_id, spend)
        op = operation_service.create(
            db,
            api_key_id=request.state.api_key_id,
            kind="payout",
            subaccount_id=account.subaccount_id,
            chain_id=body.chain_id,
            asset=body.asset.upper(),
            amount_minor=body.amount_minor,
            recipient=body.recipient,
            wallet=wallet,
            detail={
                "account_id": account.id,
                "reference": body.reference,
                "policy_version": policy_version,
                "expected_to": transaction["to"],
                "expected_data_sha256": unsigned_transaction_service.transaction_data_sha256(
                    transaction["data"]
                ),
                "protocol": "solana" if solana else "v5",
                # First input nullifier: on-chain truth for "did this spend land" (v5_reconcile).
                "nullifier": spend["public_inputs"][9],
                "relay_id": relay_id if body.submission_mode == "relay" else None,
                "relay_started_at": (
                    datetime.now(timezone.utc).isoformat()
                    if body.submission_mode == "relay"
                    else None
                ),
            },
        )
        operation_service.transition(db, op, S.screening)
        operation_service.transition(db, op, S.ready)
        operation_service.transition(db, op, S.authorized)

        tx_hash = None
        returned_transaction = transaction
        if body.submission_mode == "relay":
            # The body the executor's v5 /relaySpend takes. The executor pays gas only: every value
            # that moves is a public limb, and the payee is bound in-circuit, so it cannot redirect.
            relay_body = {"chain_id": body.chain_id, **spend}
            db.commit()
            if sandbox.is_sandbox_request(request):
                tx_hash = sandbox.fake_tx_hash("payout", op.id)
            elif solana:
                tx_hash = _relay_solana_or_settle(
                    db, op, relay_id, {"user_id": wallet, "recipient": body.recipient, "package": package}, wallet, request
                )
            else:
                # /relaySpend has no durable relay journal (relayWithdraw's lease is v1-only), so a
                # lost reply loses the tx hash — but not the outcome: v5_reconcile settles it from
                # NullifierSet, and the nullifier makes any resubmission revert, never pay twice.
                try:
                    relay_result = _relay_spend(body.chain_id, relay_body, _relay_headers(request, relay_id))
                except GatewayError as exc:
                    if exc.status < 500:
                        # The relayer refused outright, so nothing was broadcast: settle the
                        # operation and the key now instead of leaving both in flight (G-4).
                        from app.services import v5_reconcile

                        operation_service.transition(db, op, S.failed, error_code=exc.error_code.value)
                        v5_reconcile.complete_failed_reservation(db, relay_id, exc.error_code.value)
                        db.commit()
                        raise
                    # Timeout / 5xx: it may still broadcast. The operation stays authorized and the
                    # monitor settles it from the nullifier on-chain (v5_reconcile.settle_relay).
                    raise DownstreamUnavailable(
                        "The relayer did not confirm the payout. Its outcome will be settled from chain "
                        f"state; poll GET /v1/operations/{op.id} rather than resubmitting."
                    ) from exc
                tx_hash = relay_result.get("tx_hash") or relay_result.get("txHash")
            if not tx_hash:
                raise DownstreamUnavailable(
                    "Executor accepted the payout without returning a transaction hash."
                )
            operation_service.transition(db, op, S.submitted, tx_hash=tx_hash)
            returned_transaction = None

        response = PayoutResponse(
            operation=OperationView(**operation_service.public_view(op)),
            submission_mode=body.submission_mode,
            transaction=returned_transaction,
            tx_hash=tx_hash,
        )
        ctx.store(200, response.model_dump(mode="json"))
        db.commit()
        return response
