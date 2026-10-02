"""FHE key registration — gateway only tracks fingerprints, never the raw ClientKey.

GET reflects whether a server key is on file (+ fingerprint). PUT registers the server key via the
executor, rejecting an oversized body BEFORE parsing (resource-exhaustion guard). The key bytes are
never returned.
"""
import json
import hashlib

from fastapi import APIRouter, Depends, Request

from app.adapters.executor import ExecutorClient
from app.config import get_settings
from app.deps.api_key import verify_api_key
from app.deps.clients import get_executor_client
from app.deps.rate_limit import rate_limit
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox, verify_wallet_sig_or_sandbox
from app.errors import BadRequest
from app.services import sandbox
from app.schemas.errors_openapi import COMMON_ERRORS, WRITE_ERRORS
from app.schemas.strategies import FheClientKeyUpload, FheKeysStatus, FheSelfCheck, FheServerKeyUpload

router = APIRouter(prefix="/v1", tags=["FHE Keys"])


def _wallet_headers(request: Request, wallet: str) -> dict[str, str]:
    """Forward the user's auth headers to the executor's (write-challenge gated) user routes."""
    keys = ("X-Wallet-Address", "X-Signature", "X-Timestamp", "X-Write-Signature", "X-Write-Nonce")
    return {k: request.headers[k] for k in keys if k in request.headers}


def _route(request: Request, wallet: str, default: ExecutorClient) -> tuple[ExecutorClient, dict[str, str]]:
    """Solana wallets keep their FHE keys on the Devnet executor, authorized by gateway attestation."""
    from app.routers.strategies import _solana_executor

    return _solana_executor(wallet) or (default, _wallet_headers(request, wallet))


def _solana_only(request: Request, wallet: str) -> tuple[ExecutorClient, dict[str, str]]:
    from app.routers.strategies import _solana_executor

    routed = _solana_executor(wallet)
    if routed is None:
        raise BadRequest("This route serves Solana Devnet wallets; EVM wallets upload through the dapp.")
    return routed


@router.get(
    "/fhe-keys",
    operation_id="getFheKeys",
    summary="Which FHE keys are registered + fingerprints",
    response_model=FheKeysStatus,
    responses=COMMON_ERRORS,
)
async def get_fhe_keys(
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_sig_or_sandbox),
    _rl=Depends(rate_limit("read")),
    executor: ExecutorClient = Depends(get_executor_client),
) -> FheKeysStatus:
    if sandbox.is_sandbox_request(request):
        return FheKeysStatus(server_key_present=True, fingerprint="sandbox")
    executor, headers = _route(request, wallet, executor)
    data = executor.has_server_key(wallet, wallet_headers=headers)
    return FheKeysStatus(
        server_key_present=bool(
            data.get("has_key") or data.get("hasKey") or data.get("server_key_present")
        ),
        fingerprint=data.get("fingerprint"),
    )


@router.put(
    "/fhe-keys/server",
    operation_id="registerFheServerKey",
    summary="Register the FHE server key (idempotent on fingerprint; size-capped)",
    response_model=FheKeysStatus,
    responses=WRITE_ERRORS,
)
async def register_fhe_server_key(
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
    executor: ExecutorClient = Depends(get_executor_client),
) -> FheKeysStatus:
    # Size-cap BEFORE parsing (resource exhaustion): reject an oversized body outright.
    raw = await request.body()
    if len(raw) > get_settings().max_server_key_bytes:
        raise BadRequest("Server key exceeds the maximum allowed size.")
    try:
        payload = FheServerKeyUpload(**json.loads(raw))
    except Exception:
        raise BadRequest("Invalid server-key upload body.")

    sandbox.apply_scenario(request)
    if sandbox.is_sandbox_request(request):
        return FheKeysStatus(
            server_key_present=True,
            fingerprint=hashlib.sha256(payload.server_key.encode()).hexdigest()[:32],
        )

    executor, headers = _route(request, wallet, executor)
    data = executor.upload_server_key(wallet, payload.server_key, payload.canary, wallet_headers=headers)
    return FheKeysStatus(server_key_present=True, fingerprint=data.get("fingerprint"))


@router.get(
    "/fhe-keys/attestation",
    operation_id="getDecryptorAttestation",
    summary="The confidential decryptor's attestation + key to seal the FHE client key to",
    responses=COMMON_ERRORS,
)
async def decryptor_attestation(
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
) -> dict:
    """Verify it, then seal the client key to its pubkey before PUT /v1/fhe-keys/client — the
    gateway and executor only ever relay the sealed blob. Devnet runs a MOCK attester (no TDX)."""
    from app.services.v5_chains import executor

    return executor(900002)._request("GET", "/decryptorAttestation")


@router.put(
    "/fhe-keys/client",
    operation_id="registerFheClientKey",
    summary="Solana Devnet: hand the sealed FHE client key to the confidential decryptor",
    responses=WRITE_ERRORS,
)
async def register_fhe_client_key(
    body: FheClientKeyUpload,
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("proof")),
) -> dict:
    if sandbox.is_sandbox_request(request):
        return {"status": "success"}
    if len(body.client_key) > get_settings().max_ciphertext_bytes:
        raise BadRequest("Client key exceeds the maximum allowed size.")
    executor, headers = _solana_only(request, wallet)
    return executor._request("POST", "/uploadClientKey", json={"user_id": wallet, "client_key": body.client_key},
                             headers=headers)


@router.post(
    "/fhe-keys/self-check",
    operation_id="checkFheKeys",
    summary="Solana Devnet: prove the decryptor's client key matches the server key on file",
    responses=WRITE_ERRORS,
)
async def check_fhe_keys(
    body: FheSelfCheck,
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("validate")),
) -> dict:
    """Run before arming: a mismatched generation would decrypt every trigger to garbage."""
    if sandbox.is_sandbox_request(request):
        return {"consistent": True}
    executor, headers = _solana_only(request, wallet)
    return executor._request("POST", "/selfCheckKeys", json={"user_id": wallet, "encrypted_canary": body.encrypted_canary},
                             headers=headers)
