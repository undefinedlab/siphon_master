"""Legacy enclave-managed accounts, retained only as an explicit migration surface.

Contrast with `POST /v1/deposits`, which requires the caller to supply a `precommitment` they
computed themselves. Here the enclave keeper derives the note and the caller only ever handles
ordinary values: an amount, an asset, and calldata to broadcast.

Deliberately NOT wallet-signature gated. A managed account has no user wallet — that is the point.
Authority is the API key plus (optionally) the subaccount, and the note material is enclave-held,
so there is no signature a caller could produce that would add security here.
"""
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.adapters.keeper import KeeperClient
from app.deps.api_key import verify_api_key
from app.deps.idempotency import idempotent, request_scope
from app.deps.rate_limit import rate_limit
from app.errors import BadRequest, DownstreamUnavailable, NotFound
from app.repository.models import ManagedAccount, ManagedNote
from app.repository.session import get_db
from app.schemas.errors_openapi import COMMON_ERRORS, WRITE_ERRORS
from app.schemas.platform import (
    ManagedAccountCreateRequest,
    ManagedAccountList,
    ManagedAccountView,
    ManagedDepositConfirmRequest,
    ManagedDepositRequest,
    ManagedDepositResponse,
    ManagedNoteList,
    ManagedNoteView,
    ManagedRecoveryResponse,
)
from app.schemas.compliance import BusinessOperationState as S
from app.services import (
    managed_account_service as accounts_svc,
    operation_service,
    policy_service,
    sandbox,
    subaccount_service,
)

router = APIRouter(prefix="/v1", tags=["Legacy Managed Accounts"])


def get_keeper() -> KeeperClient:
    from app.adapters.keeper import get_keeper_client

    return get_keeper_client()


def _enabled() -> None:
    from app.config import get_settings

    if not get_settings().managed_accounts_enabled:
        raise DownstreamUnavailable("Managed accounts are not enabled on this deployment.")


@router.post(
    "/managed-accounts",
    operation_id="createManagedAccount",
    summary="Create an enclave-custodied shielded account",
    response_model=ManagedAccountView,
    responses=WRITE_ERRORS,
)
async def create_account(
    body: ManagedAccountCreateRequest,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("validate")),
    db: Session = Depends(get_db),
    keeper: KeeperClient = Depends(get_keeper),
) -> ManagedAccountView:
    _enabled()
    api_key_id = request.state.api_key_id
    sub = subaccount_service.resolve(db, api_key_id, body.subaccount)

    row = accounts_svc.create(
        db,
        keeper,
        api_key_id=api_key_id,
        external_ref=body.external_ref,
        subaccount_id=sub.id if sub else None,
        label=body.label,
    )
    db.commit()
    return ManagedAccountView(**accounts_svc.public_view(db, row))


@router.get(
    "/managed-accounts",
    operation_id="listManagedAccounts",
    summary="List managed accounts with shielded balances",
    response_model=ManagedAccountList,
    responses=COMMON_ERRORS,
)
async def list_accounts(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> ManagedAccountList:
    rows = (
        db.query(ManagedAccount)
        .filter(
            ManagedAccount.api_key_id == request.state.api_key_id,
            ManagedAccount.control_mode == "enclave_custody",
        )
        .order_by(ManagedAccount.created_at.desc())
        .limit(limit)
        .all()
    )
    return ManagedAccountList(
        accounts=[ManagedAccountView(**accounts_svc.public_view(db, r)) for r in rows]
    )


@router.get(
    "/managed-accounts/{id}",
    operation_id="getManagedAccount",
    summary="Get one managed account (accepts our id or your external_ref)",
    response_model=ManagedAccountView,
    responses=COMMON_ERRORS,
)
async def get_account(
    id: str,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> ManagedAccountView:
    row = accounts_svc.resolve(db, request.state.api_key_id, id)
    return ManagedAccountView(**accounts_svc.public_view(db, row))


@router.get(
    "/managed-accounts/{id}/notes",
    operation_id="listManagedNotes",
    summary="List an account's notes (public values only — never secrets)",
    response_model=ManagedNoteList,
    responses=COMMON_ERRORS,
)
async def list_notes(
    id: str,
    request: Request,
    status: str | None = Query(default=None, description="pending | confirmed | spent"),
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    db: Session = Depends(get_db),
) -> ManagedNoteList:
    account = accounts_svc.resolve(db, request.state.api_key_id, id)
    rows = accounts_svc.notes(db, account.id, status=status)
    return ManagedNoteList(notes=[ManagedNoteView(**accounts_svc.note_view(n)) for n in rows])


@router.post(
    "/managed-accounts/{id}/deposits",
    operation_id="createManagedDeposit",
    summary="Derive a note in the enclave and return ready-to-send deposit calldata",
    response_model=ManagedDepositResponse,
    responses=WRITE_ERRORS,
)
async def create_deposit(
    id: str,
    body: ManagedDepositRequest,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("proof")),
    db: Session = Depends(get_db),
    keeper: KeeperClient = Depends(get_keeper),
) -> ManagedDepositResponse:
    _enabled()
    api_key_id = request.state.api_key_id
    sandbox.apply_scenario(request)

    account = accounts_svc.resolve(db, api_key_id, id)

    pool = sandbox.fake_pool_state(body.chain_id, body.asset) if sandbox.is_sandbox_request(request) else {}
    policy_version = policy_service.enforce(
        db,
        api_key_id=api_key_id,
        chain_id=body.chain_id,
        asset=body.asset,
        amount_minor=body.amount_minor,
        anonymity_set=pool.get("anonymity_set"),
        asp_root_stale=pool.get("asp_root_stale"),
        subaccount_id=account.subaccount_id,
    )

    idem_key = request.headers.get("Idempotency-Key")
    with idempotent(db, idem_key, body.model_dump(), scope=request_scope(request)) as ctx:
        if ctx.stored is not None:
            status_code, resp_body = ctx.stored
            if status_code >= 400:
                from fastapi.responses import JSONResponse

                return JSONResponse(status_code=status_code, content=resp_body)
            return ManagedDepositResponse(**resp_body)

        op = operation_service.create(
            db,
            api_key_id=api_key_id,
            kind="deposit",
            subaccount_id=account.subaccount_id,
            chain_id=body.chain_id,
            asset=body.asset,
            amount_minor=body.amount_minor,
            wallet=account.owner_address,
            detail={"managed_account_id": account.id, "policy_version": policy_version},
        )

        scope, nonce = _scope_and_nonce(request, body.chain_id, body.asset, account)
        note = accounts_svc.allocate_note(
            db,
            keeper,
            account=account,
            chain_id=body.chain_id,
            asset=body.asset,
            amount_minor=body.amount_minor,
            scope=scope,
            nonce=nonce,
            operation_id=op.id,
        )

        entrypoint, calldata, value = _deposit_calldata(request, body, note)
        operation_service.transition(db, op, S.awaiting_deposit)

        resp = ManagedDepositResponse(
            operation_id=op.id,
            account_id=account.id,
            note=ManagedNoteView(**accounts_svc.note_view(note)),
            deposit_address=entrypoint,
            calldata=calldata,
            value=value,
        )
        ctx.store(200, _jsonable(resp.model_dump()))
        db.commit()
        return resp


def _scope_and_nonce(request: Request, chain_id: int, asset: str, account) -> tuple[int, int]:
    """Label inputs. On-chain the vault mints `label = Poseidon(uint160(vault), ++depositNonce)`;
    the real nonce is only known after the tx executes, so a pre-computed label here is provisional
    and is reconciled at confirmation."""
    if sandbox.is_sandbox_request(request):
        return int(sandbox.fake_pool_state(chain_id, asset)["asp_root"][:18], 16), account.next_note_index
    raise BadRequest(
        "Managed deposits against a live chain require the vault scope/nonce from the deployment "
        "manifest; configure it before enabling managed accounts outside sandbox."
    )


def _deposit_calldata(request: Request, body: ManagedDepositRequest, note: ManagedNote):
    if sandbox.is_sandbox_request(request):
        return (
            "0x" + sandbox.fake_tx_hash("entrypoint", body.chain_id)[2:42],
            sandbox.fake_note_commitment("calldata", note.commitment),
            "0",
        )
    from app.services.note_service import encode_deposit_calldata, get_asset_address

    asset_address = get_asset_address(body.chain_id, body.asset)
    calldata = encode_deposit_calldata(asset_address, body.amount_minor, int(note.precommitment))
    return asset_address, calldata, "0"


def _jsonable(d: dict) -> dict:
    from datetime import datetime

    out = {}
    for k, v in d.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        elif isinstance(v, dict):
            out[k] = _jsonable(v)
        else:
            out[k] = v
    return out


@router.post(
    "/managed-accounts/{id}/deposits/{operation_id}/confirmation",
    operation_id="confirmManagedDeposit",
    summary="Confirm a mined managed deposit",
    responses=WRITE_ERRORS,
)
async def confirm_deposit(
    id: str,
    operation_id: str,
    body: ManagedDepositConfirmRequest,
    request: Request,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("proof")),
    db: Session = Depends(get_db),
):
    api_key_id = request.state.api_key_id
    account = accounts_svc.resolve(db, api_key_id, id)
    op = operation_service.get_owned(db, operation_id, api_key_id)

    note = (
        db.query(ManagedNote)
        .filter(ManagedNote.operation_id == op.id, ManagedNote.account_id == account.id)
        .first()
    )
    if note is None:
        raise NotFound("No managed note is associated with that operation.")

    accounts_svc.confirm_note(db, note, tx_hash=body.tx_hash)
    operation_service.transition(db, op, S.confirmed, tx_hash=body.tx_hash)
    db.commit()

    return {
        "operation_id": op.id,
        "account_id": account.id,
        "note_id": note.id,
        "status": note.status,
        "balance_minor": accounts_svc.balance_minor(db, account.id),
    }


@router.post(
    "/managed-accounts/{id}/recover",
    operation_id="recoverManagedNotes",
    summary="Re-derive an account's notes from the enclave (disaster recovery)",
    response_model=ManagedRecoveryResponse,
    responses=WRITE_ERRORS,
)
async def recover(
    id: str,
    request: Request,
    start: int = Query(default=0, ge=0),
    count: int = Query(default=50, ge=1, le=500),
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("proof")),
    db: Session = Depends(get_db),
    keeper: KeeperClient = Depends(get_keeper),
) -> ManagedRecoveryResponse:
    """The capability random note secrets cannot offer.

    Note material is `HKDF(master, keeper_ref) -> H(seed, field, index)`, so the enclave can
    reconstruct any index on demand. If this database were lost entirely, scanning here and matching
    commitments against the on-chain tree rebuilds the account. Losing the note index is an
    availability problem, not a loss of funds.
    """
    _enabled()
    account = accounts_svc.resolve(db, request.state.api_key_id, id)
    result = keeper.reconstruct(keeper_ref=account.keeper_ref, start=start, count=count)
    return ManagedRecoveryResponse(
        account_id=account.id, scanned=count, notes=result.get("notes", [])
    )
