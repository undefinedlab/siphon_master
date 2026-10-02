"""Self-custody accounts and deposits: API access without API spend authority."""

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy.orm import Session

from app.deps.api_key import verify_api_key
from app.deps.idempotency import idempotent, request_scope
from app.deps.rate_limit import rate_limit
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox
from app.errors import BadRequest, Forbidden
from app.repository.models import ManagedAccount
from app.repository.session import get_db
from app.schemas.business import (
    AccountCreateRequest,
    AccountDepositRequest,
    AccountDepositResponse,
    AccountList,
    AccountView,
)
from app.schemas.errors_openapi import COMMON_ERRORS, WRITE_ERRORS
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

router = APIRouter(prefix="/v1", tags=["Accounts"])


def _assert_account_wallet(account: ManagedAccount, wallet: str) -> None:
    if not account.owner_address or account.owner_address.lower() != wallet.lower():
        raise Forbidden("The signing wallet does not control this account.")


def _devnet_key_guard(request: Request, chain_id: int) -> None:
    from app.services import solana_devnet
    from app.services.v5_chains import devnet_only

    if devnet_only(request) and not solana_devnet.is_solana(chain_id):
        raise Forbidden("This is a free Solana Devnet key; it only works with chain_id 900002.")


def _screen(request: Request, address: str, chain_id: int) -> None:
    if sandbox.is_sandbox_request(request):
        return
    from app.services.sanctions import screen_address

    screen_address(address, chain_id)


@router.post(
    "/accounts",
    operation_id="createAccount",
    summary="Register a wallet-controlled private account",
    response_model=AccountView,
    status_code=status.HTTP_201_CREATED,
    responses=WRITE_ERRORS,
)
async def create_account(
    body: AccountCreateRequest,
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("validate")),
    db: Session = Depends(get_db),
) -> AccountView:
    if body.wallet_address and body.wallet_address.lower() != wallet.lower():
        raise Forbidden("wallet_address must match the wallet that signed this request.")
    _devnet_key_guard(request, body.chain_id)
    _screen(request, wallet, body.chain_id)
    sub = subaccount_service.resolve(db, request.state.api_key_id, body.subaccount)

    with idempotent(
        db,
        request.headers.get("Idempotency-Key"),
        body.model_dump(),
        scope=request_scope(request, wallet=wallet),
    ) as ctx:
        if ctx.stored is not None:
            return AccountView(**ctx.stored[1])
        row = account_service.create(
            db,
            api_key_id=request.state.api_key_id,
            external_ref=body.external_ref,
            wallet_address=wallet,
            subaccount_id=sub.id if sub else None,
            label=body.label,
        )
        response = AccountView(**account_service.public_view(db, row))
        ctx.store(status.HTTP_201_CREATED, response.model_dump(mode="json"))
        db.commit()
        return response


@router.get(
    "/accounts",
    operation_id="listAccounts",
    summary="List self-custody account registrations",
    response_model=AccountList,
    responses=COMMON_ERRORS,
)
async def list_accounts(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> AccountList:
    rows = db.query(ManagedAccount).filter(
        ManagedAccount.api_key_id == request.state.api_key_id,
        ManagedAccount.control_mode == "self_custody",
    ).order_by(ManagedAccount.created_at.desc()).limit(limit).all()
    return AccountList(
        accounts=[AccountView(**account_service.public_view(db, row)) for row in rows]
    )


@router.get(
    "/accounts/{id}",
    operation_id="getAccount",
    summary="Get a self-custody account by id or external_ref",
    response_model=AccountView,
    responses=COMMON_ERRORS,
)
async def get_account(
    id: str,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> AccountView:
    row = account_service.resolve(db, request.state.api_key_id, id)
    return AccountView(**account_service.public_view(db, row))


@router.post(
    "/accounts/{id}/deposits",
    operation_id="createAccountDeposit",
    summary="Create unsigned deposit transactions for a client-held note",
    response_model=AccountDepositResponse,
    responses=WRITE_ERRORS,
)
async def create_deposit(
    id: str,
    body: AccountDepositRequest,
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
    db: Session = Depends(get_db),
) -> AccountDepositResponse:
    sandbox.apply_scenario(request)
    from app.services.v5_chains import access

    solana = access(request, body.chain_id)
    if solana and not body.commitment:
        raise BadRequest("Solana Devnet deposits need `commitment` (see GET /v1/chains/900002/vault).")
    account = account_service.resolve(db, request.state.api_key_id, id)
    _assert_account_wallet(account, wallet)
    _screen(request, wallet, body.chain_id)
    pool = sandbox.fake_pool_state(body.chain_id, body.asset) if sandbox.is_sandbox_request(request) else {}
    policy_version = policy_service.enforce(
        db,
        api_key_id=request.state.api_key_id,
        chain_id=body.chain_id,
        asset=body.asset,
        amount_minor=body.amount_minor,
        anonymity_set=pool.get("anonymity_set"),
        asp_root_stale=pool.get("asp_root_stale"),
        subaccount_id=account.subaccount_id,
    )

    with idempotent(
        db,
        request.headers.get("Idempotency-Key"),
        body.model_dump(),
        scope=request_scope(request, wallet=wallet),
    ) as ctx:
        if ctx.stored is not None:
            return AccountDepositResponse(**ctx.stored[1])
        if sandbox.is_sandbox_request(request):
            plan = _sandbox_plan(body, wallet)
        elif solana:
            plan = _solana_plan(body, wallet)
        else:
            plan = unsigned_transaction_service.deposit_plan(
                chain_id=body.chain_id,
                asset=body.asset,
                amount_minor=body.amount_minor,
                wallet=wallet,
                precommitment=body.precommitment,
                user_salt=body.user_salt,
            )
        if plan["phase"] == "approve":
            # No operation yet: nothing the ASP could screen exists until the allowance does.
            response = AccountDepositResponse(operation=None, phase="approve", transactions=plan["transactions"])
            ctx.store(200, response.model_dump(mode="json"))
            db.commit()
            return response

        if not sandbox.is_sandbox_request(request):
            _screen_deposit(body, wallet, plan["commitment"])
        deposit_tx = plan["transactions"][-1]
        expected = (
            {"expected_to": plan["program_id"], "expected_data_sha256": plan["deposit_data_sha256"], "protocol": "solana"}
            if solana else
            {"expected_to": deposit_tx["to"],
             "expected_data_sha256": unsigned_transaction_service.transaction_data_sha256(deposit_tx["data"]),
             "protocol": "v5"}
        )
        op = operation_service.create(
            db,
            api_key_id=request.state.api_key_id,
            kind="deposit",
            subaccount_id=account.subaccount_id,
            chain_id=body.chain_id,
            asset=body.asset.upper(),
            amount_minor=body.amount_minor,
            wallet=wallet,
            detail={
                "account_id": account.id,
                "policy_version": policy_version,
                **expected,
                # The commitment screened here is a PREDICTION (it depends on the kernel's deposit
                # counter at mining time). Admission therefore runs again from the mined event once
                # the deposit confirms — see v5_reconcile.admit_deposit (G-1). On Solana the program
                # enforces the client's commitment, and solasp's watcher admits it from the chain.
                "commitment": plan["commitment"],
                "admission": None if sandbox.is_sandbox_request(request) else ("asp_watcher" if solana else "pending"),
            },
        )
        operation_service.transition(db, op, S.awaiting_deposit)
        response = AccountDepositResponse(
            operation=OperationView(**operation_service.public_view(op)),
            phase="deposit",
            commitment=plan["commitment"],
            screening={"decision": "admit", "fee_paid": True},
            transactions=plan["transactions"],
        )
        ctx.store(200, response.model_dump(mode="json"))
        db.commit()
        return response


def _sandbox_plan(body, wallet: str) -> dict:
    from app.services.v5_chains import chain

    c = chain(body.chain_id)
    token, native = c.token(body.asset)
    return {
        "phase": "deposit",
        "commitment": str(int(sandbox.fake_note_commitment(wallet, body.precommitment), 16) % (1 << 253)),
        "transactions": [{
            "chain_id": body.chain_id,
            "to": c.vault_kernel,
            "data": "0x" + sandbox.fake_tx_hash("deposit", wallet, body.precommitment)[2:],
            "value": str(body.amount_minor if native else 0),
            "purpose": "deposit",
        }],
    }


def _solana_plan(body, wallet: str) -> dict:
    from app.services import solana_devnet

    built = solana_devnet.deposit_plan(
        asset=body.asset, amount_minor=body.amount_minor, wallet=wallet,
        precommitment=body.precommitment, user_salt=body.user_salt, commitment=body.commitment,
    )
    return {
        "phase": "deposit",
        "commitment": body.commitment,
        "program_id": str(solana_devnet.program_id()),
        "deposit_data_sha256": built["deposit_data_sha256"],
        "transactions": [{
            "chain_id": body.chain_id, "encoding": "base64", "transaction": built["transaction"],
            "purpose": "deposit", "last_valid_block_height": built["last_valid_block_height"],
        }],
    }


def _screen_deposit(body, wallet: str, commitment: str) -> None:
    """ASP screening of the exact deposit about to be signed. Only `admit` releases the tx.

    The ASP records a PENDING entry keyed by (commitment, userSalt); its deposit watcher admits the
    label once the deposit is mined. The fee check lives inside /screen: an unpaid wallet gets 402.
    """
    from app.errors import AspUnavailable, ComplianceDenied, ComplianceFeeRequired, CompliancePending, GatewayError
    from app.services import solana_devnet
    from app.services.v5_chains import asp, chain

    if solana_devnet.is_solana(body.chain_id):
        # Base58 is case-sensitive; solasp keys the pending admission on the DECIMAL commitment.
        depositor, token = wallet, str(solana_devnet.mint_for(body.asset)[0])
    else:
        depositor, token = wallet.lower(), chain(body.chain_id).token(body.asset)[0]
    try:
        result = asp(body.chain_id).screen({
            "chainId": body.chain_id,
            "depositor": depositor,
            "commitment": commitment,
            "userSalt": body.user_salt,
            "asset": token,
        })
    except GatewayError as exc:
        if exc.status >= 500 and not isinstance(exc, AspUnavailable):
            raise AspUnavailable("The compliance service is unavailable; nothing was signed.") from exc
        raise
    decision = str(result.get("decision", "")).lower()
    if result.get("error") == "kyt_fee_required" or decision == "kyt_fee_required":
        raise ComplianceFeeRequired("This wallet has not paid its compliance fee on this chain. See GET /v1/compliance-fee.")
    if decision == "deny":
        raise ComplianceDenied("The depositing wallet did not pass compliance screening.")
    if decision != "admit":
        raise CompliancePending("Screening has not cleared this deposit yet; retry shortly.")
