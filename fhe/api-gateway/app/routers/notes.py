import uuid
from web3 import Web3
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.deps.api_key import verify_api_key
from app.deps.rate_limit import rate_limit
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox, verify_wallet_sig
from app.repository.session import get_db
from app.deps.idempotency import idempotent, request_scope
from app.schemas.errors_openapi import COMMON_ERRORS, WRITE_ERRORS
from app.schemas.notes import (
    NoteList,
    DepositIntentRequest,
    DepositIntentResponse,
    DepositConfirmationRequest,
)
from app.services import note_service
from app.errors import BadRequest, NotFound, Forbidden, Conflict

router = APIRouter(prefix="/v1", tags=["Pool"])

ENTRYPOINT_DEPOSIT_ABI = [{
    "inputs": [
        {"internalType": "address", "name": "_asset", "type": "address"},
        {"internalType": "uint256", "name": "_amount", "type": "uint256"},
        {"internalType": "uint256", "name": "_precommitment", "type": "uint256"}
    ],
    "name": "deposit",
    "outputs": [{"internalType": "uint256", "name": "_commitment", "type": "uint256"}],
    "stateMutability": "payable",
    "type": "function"
}]


def get_asset_address(chain_id: int, asset: str) -> str:
    from evm_chain_config import get_evm_chain_config
    try:
        config = get_evm_chain_config(chain_id)
    except Exception as e:
        raise BadRequest(f"Unsupported chain_id {chain_id}: {e}")

    if asset.upper() == "ETH":
        from evm_chain_config import NATIVE_ASSET
        return NATIVE_ASSET
    elif asset.upper() == "USDC":
        return config.usdc
    else:
        raise BadRequest(f"Unsupported asset {asset} on chain {chain_id}")


def get_asset_decimals(asset: str) -> int:
    if asset.upper() == "ETH":
        return 18
    elif asset.upper() == "USDC":
        return 6
    else:
        raise BadRequest(f"Unsupported asset {asset}")


def encode_deposit_calldata(asset_address: str, amount_wei: int, precommitment: int) -> str:
    w3 = Web3()
    contract = w3.eth.contract(abi=ENTRYPOINT_DEPOSIT_ABI)
    return contract.encode_abi("deposit", [
        Web3.to_checksum_address(asset_address),
        amount_wei,
        precommitment
    ])


@router.get(
    "/notes",
    operation_id="listNotes",
    summary="List the wallet's notes + spendable balance",
    response_model=NoteList,
    responses=COMMON_ERRORS,
)
async def list_notes(
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_sig),
    _rl=Depends(rate_limit("read")),
) -> NoteList:
    # Owner-scoped by construction: the service queries only this authed wallet's notes.
    return NoteList(**note_service.list_notes(wallet))


@router.post(
    "/deposits",
    operation_id="createDeposit",
    summary="Create a deposit intent (note material + calldata)",
    response_model=DepositIntentResponse,
    responses=WRITE_ERRORS,
)
async def create_deposit(
    request: Request,
    body: DepositIntentRequest,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
    db: Session = Depends(get_db),
) -> DepositIntentResponse:
    # 1. Screen sanctions (fail-closed)
    from app.services.sanctions import screen_address
    screen_address(wallet, body.chain_id)

    # The server chooses the only deposit-capable generation. A caller can never route a deposit
    # to an exit-only vault, and chains without an active Hard ASP generation fail closed.
    from app.services.vault_generation import resolve_deposit_generation, rejection_message
    from app.errors import VaultExitOnly, VaultGenerationUnavailable
    generation = resolve_deposit_generation(body.chain_id)
    if not generation["valid"]:
        exc = VaultExitOnly if generation["code"] == "VAULT_EXIT_ONLY" else VaultGenerationUnavailable
        raise exc(rejection_message(generation["code"]))

    idem_key = request.headers.get("Idempotency-Key")
    with idempotent(db, idem_key, body.model_dump(), scope=request_scope(request, wallet=wallet)) as ctx:
        if ctx.stored is not None:
            status_code, resp_body = ctx.stored
            if status_code >= 400:
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=status_code, content=resp_body)
            return DepositIntentResponse(**resp_body)

        # 2. Build calldata
        try:
            from decimal import Decimal
            asset_address = get_asset_address(body.chain_id, body.asset)
            decimals = get_asset_decimals(body.asset)
            amount_wei = int(Decimal(body.amount) * (10 ** decimals))
            precommitment_int = int(body.precommitment, 0)
            calldata = encode_deposit_calldata(asset_address, amount_wei, precommitment_int)

        except Exception as e:
            if isinstance(e, HTTPException):
                raise
            raise BadRequest(f"Invalid deposit parameters: {e}")

        deposit_id = body.precommitment
        note_material_ref = f"ref_{deposit_id}"

        res = DepositIntentResponse(
            deposit_id=deposit_id,
            note_material_ref=note_material_ref,
            calldata=calldata,
            vault_generation_id=generation["generation_id"],
        )

        ctx.store(200, res.model_dump())
        db.commit()
        return res


@router.post(
    "/deposits/{id}/confirmation",
    operation_id="confirmDeposit",
    summary="Confirm a mined deposit (tx_hash) -> note spendable",
    responses=WRITE_ERRORS,
)
async def confirm_deposit(
    id: str,
    body: DepositConfirmationRequest,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
):
    from app.repository.note_db import NoteRow, _note_session
    from app.services.sanctions import screen_address
    from app.services.confirmations import is_confirmed

    note_session = _note_session()
    try:
        note = note_session.query(NoteRow).filter(
            (NoteRow.id == id) | (NoteRow.commitment == id)
        ).first()

        if not note or note.wallet.lower() != wallet.lower():
            raise NotFound("Deposit note not found.")

        chain_id = note.chain_id

        # Screen wallet again at confirmation time (fail-closed)
        screen_address(wallet, chain_id)

        # Verify confirmation block depth
        if not is_confirmed(chain_id, body.tx_hash):
            raise Conflict("Transaction has not reached the required block confirmation threshold.")

        note.spent = "false"
        note_session.commit()

        return {"deposit_id": id, "status": "confirmed"}
    finally:
        note_session.close()
