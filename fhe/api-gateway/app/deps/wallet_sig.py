"""Wallet authorization for legacy reads and exact, replay-safe mutation intents.

Message: `Siphon API v1:{chain_id}:{timestamp}`, or `…:{nonce}` when the client sends `X-Nonce`
(EIP-191 personal_sign). A Solana wallet (base58 X-Wallet-Address) signs the same text with ed25519
and sends the signature base64; its address is kept verbatim, never lowercased.

Order of checks (reject before any business logic):
  1. freshness: |now - timestamp| <= 300s, else 401 stale_signature
  2. recovery:  recovered address == X-Wallet-Address, else 401 unauthorized
  3. nonce:     (wallet, timestamp, nonce, sig) SETNX in Redis with 300s TTL; present -> 409 replayed

`X-Nonce` is BINDING: if the header is present the signature must cover the nonce-suffixed message.
Sending a nonce alongside a signature that did not commit to it is rejected, not downgraded. Clients
should send a unique nonce per request so two calls in the same second do not collide.
`verify_wallet_intent` is the authorization boundary for new fund-moving APIs. Its v2 message binds
the chain, freshness timestamp, mandatory nonce, HTTP method, route and canonical JSON body. An API
key can therefore access Siphon's service, but cannot alter or replay a user's signed instruction.
"""
import hashlib
import json
import time

import redis as redis_lib
from fastapi import Depends, Request

from app.deps.api_key import verify_api_key
from app.errors import ReplayedRequest, StaleSignature, Unauthorized
from app.reuse import (
    SESSION_HEADER,
    delegated_signer_authorizes,
    is_solana_address,
    recover_wallet,
    solana_signature_valid,
)

FRESHNESS_WINDOW_SECONDS = 300


def _valid_nonce(nonce: str) -> str:
    nonce_s = (nonce or "").strip()
    if not nonce_s or len(nonce_s) > 128 or any(c in nonce_s for c in " \n\r\t"):
        raise Unauthorized("A unique X-Nonce is required and must be at most 128 non-space characters.")
    return nonce_s


def _wallet_id(wallet: str) -> tuple[str, bool]:
    """(normalized wallet, solana?) — base58 keeps its case, an EVM address is lowercased."""
    raw = (wallet or "").strip()
    if is_solana_address(raw):
        return raw, True
    return raw.lower(), False


def canonical_body_sha256(body: dict | None) -> str:
    """Hash a stable JSON representation so harmless object-key ordering does not change intent."""
    encoded = json.dumps(
        body or {}, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def canonical_intent_message(
    *,
    chain_id: int | str,
    timestamp: str,
    nonce: str,
    method: str,
    path: str,
    body: dict | None,
) -> str:
    """The exact EIP-191 text signed by self-custody clients."""
    return "\n".join(
        (
            "Siphon API v2",
            f"chain_id:{chain_id}",
            f"timestamp:{timestamp}",
            f"nonce:{nonce}",
            f"method:{method.upper()}",
            f"path:{path}",
            f"body_sha256:{canonical_body_sha256(body)}",
        )
    )


def check_wallet_intent(
    redis: redis_lib.Redis,
    *,
    wallet: str,
    signature: str,
    timestamp: str,
    nonce: str,
    chain_id: int | str,
    method: str,
    path: str,
    body: dict | None,
) -> str:
    """Verify one exact wallet mutation intent and consume its wallet-global nonce."""
    wallet_l, solana = _wallet_id(wallet)
    if not wallet_l or not signature or not timestamp:
        raise Unauthorized("Missing wallet authorization headers.")

    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        raise Unauthorized("Invalid timestamp.")
    if abs(int(time.time()) - ts) > FRESHNESS_WINDOW_SECONDS:
        raise StaleSignature("Signature timestamp outside the 300s freshness window.")

    nonce_s = _valid_nonce(nonce)
    message = canonical_intent_message(
        chain_id=chain_id,
        timestamp=timestamp,
        nonce=nonce_s,
        method=method,
        path=path,
        body=body,
    )
    if solana:
        valid = solana_signature_valid(message, signature, wallet_l)
    else:
        valid = recover_wallet(message, signature) == wallet_l
    if not valid:
        raise Unauthorized(
            "Wallet signature does not match this request. Sign the canonical Siphon API v2 "
            "intent for the exact method, path and JSON body."
        )

    # A nonce is unique for the wallet, not merely for one signature. This prevents a signer from
    # accidentally authorizing two different requests with the same application nonce.
    key = f"walletintent:{wallet_l}:{nonce_s}"
    if not redis.set(key, "1", nx=True, ex=FRESHNESS_WINDOW_SECONDS):
        raise ReplayedRequest("This wallet intent nonce has already been used.")
    return wallet_l


def _nonce_key(wallet: str, timestamp: str, signature: str, nonce: str = "") -> str:
    return f"walletnonce:{wallet}:{timestamp}:{nonce}:{signature}"


def check_wallet_sig(
    redis: redis_lib.Redis,
    *,
    wallet: str,
    signature: str,
    timestamp: str,
    chain_id: int | str,
    nonce: str = "",
    delegation: str | None = None,
) -> str:
    """Verify a wallet signature; return the normalized wallet address or raise a GatewayError."""
    wallet_l, solana = _wallet_id(wallet)
    if not wallet_l or not signature or not timestamp:
        raise Unauthorized("Missing wallet signature headers.")

    # 1) freshness
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        raise Unauthorized("Invalid timestamp.")
    if abs(int(time.time()) - ts) > FRESHNESS_WINDOW_SECONDS:
        raise StaleSignature("Signature timestamp outside the 300s freshness window.")

    # 2) recovery — message is exactly what the dapp signs (see siphon_judge apiKeys.ts)
    message = f"Siphon API v1:{chain_id}:{timestamp}"
    nonce_s = (nonce or "").strip()
    if nonce_s:
        if len(nonce_s) > 128 or any(c in nonce_s for c in " \n\r\t"):
            raise Unauthorized("Invalid nonce.")
        # Binding, not advisory: when X-Nonce is present the signature MUST cover
        # `Siphon API v1:{chain}:{ts}:{nonce}`. There is deliberately no fallback to the
        # nonce-less message — that fallback let any caller attach an arbitrary nonce to a
        # signature that never committed to one, so the nonce constrained nothing.
        message = f"{message}:{nonce_s}"
    recovered = (wallet_l if solana_signature_valid(message, signature, wallet_l) else None) if solana \
        else recover_wallet(message, signature)
    # A session key may sign on the wallet's behalf when the request carries a delegation proving
    # the wallet authorized it. Checked only AFTER direct recovery fails, so the existing path is
    # unchanged and SDK/agent callers signing with the wallet keep working untouched.
    if not solana and recovered is not None and recovered != wallet_l and delegated_signer_authorizes(
        delegation, recovered, wallet_l
    ):
        recovered = wallet_l
    if recovered is None or recovered != wallet_l:
        raise Unauthorized(
            "Wallet signature does not match. "
            f"Expected {'an ed25519 signature (base64)' if solana else 'EIP-191 personal_sign'} of exactly: "
            f"{message} from {wallet_l}."
            + (" X-Nonce is present, so the nonce must be part of the signed message." if nonce_s else "")
        )

    # 3) nonce cache — SETNX with TTL; a replay within the window fails to set -> reject
    key = _nonce_key(wallet_l, timestamp, signature, nonce_s)
    if not redis.set(key, "1", nx=True, ex=FRESHNESS_WINDOW_SECONDS):
        raise ReplayedRequest("This signature has already been used.")

    return wallet_l


def _extract_chain_id(request: Request, body: dict | None) -> str:
    if body and "chain_id" in body:
        return str(body["chain_id"])
    if body and "from_chain" in body:
        return str(body["from_chain"])
    # v5 routes name it {chain_id} (/v1/chains/{chain_id}/…); reading only {chain} left those reads
    # bound to chain "" so every client signing its real chain got 401.
    for name in ("chain", "chain_id"):
        if name in request.path_params:
            return str(request.path_params[name])
    return str(request.query_params.get("chain_id", ""))


async def verify_wallet_sig(request: Request) -> str:
    """FastAPI dependency: verify the wallet signature for this request, returning the wallet address.

    chain_id is taken from the JSON body (fund-moving POSTs) or the path/query (reads scoped to a
    wallet). The signed message binds the chain, so the client and gateway must agree on it.

    Body is read via request.body() so Starlette caches it for the route's Pydantic model.
    """
    from app.repository.redis_client import get_redis

    body: dict | None = None
    if request.method in ("POST", "PUT", "PATCH"):
        try:
            import json

            raw = await request.body()
            body = json.loads(raw) if raw else None
            if body is not None and not isinstance(body, dict):
                body = None
        except Exception:
            body = None

    return check_wallet_sig(
        get_redis(),
        wallet=request.headers.get("X-Wallet-Address", ""),
        signature=request.headers.get("X-Signature", ""),
        timestamp=request.headers.get("X-Timestamp", ""),
        chain_id=_extract_chain_id(request, body),
        nonce=request.headers.get("X-Nonce", ""),
        delegation=request.headers.get(SESSION_HEADER),
    )


async def verify_wallet_sig_or_sandbox(request: Request, key=Depends(verify_api_key)) -> str:
    """Wallet signature, except for sandbox keys, which act as a deterministic fake wallet.

    A wallet signature authorizes moving REAL funds. A `sk_test_` key moves nothing, so demanding
    one buys no security and makes the sandbox unusable — an evaluating integrator has no funded
    wallet and no way to produce EIP-191 signatures for one.

    Sandbox is decided by the KEY's plan (set in `verify_api_key`), never by a client header, so a
    production key can never take this branch. `key=Depends(verify_api_key)` is declared explicitly
    so the dependency graph — not signature declaration order — guarantees `request.state.sandbox`
    is populated before this runs. FastAPI de-dupes the shared dependency, so it resolves once.
    """
    if getattr(request.state, "sandbox", False):
        from app.services.sandbox import fake_wallet

        return fake_wallet(key.id)
    return await verify_wallet_sig(request)


async def verify_wallet_intent(request: Request) -> str:
    """Verify an exact v2 intent for a state-changing JSON request."""
    from app.repository.redis_client import get_redis

    body: dict | None = None
    try:
        raw = await request.body()
        body = json.loads(raw) if raw else {}
    except Exception:
        raise Unauthorized("Wallet-authorized requests must contain a valid JSON object.")
    if not isinstance(body, dict):
        raise Unauthorized("Wallet-authorized requests must contain a JSON object.")

    return check_wallet_intent(
        get_redis(),
        wallet=request.headers.get("X-Wallet-Address", ""),
        signature=request.headers.get("X-Signature", ""),
        timestamp=request.headers.get("X-Timestamp", ""),
        nonce=request.headers.get("X-Nonce", ""),
        chain_id=_extract_chain_id(request, body),
        method=request.method,
        path=request.url.path,
        body=body,
    )


async def verify_wallet_intent_or_sandbox(
    request: Request, key=Depends(verify_api_key)
) -> str:
    """Exact wallet intent, with a deterministic non-fund-moving identity for test keys."""
    if getattr(request.state, "sandbox", False):
        from app.services.sandbox import fake_wallet

        return fake_wallet(key.id)
    return await verify_wallet_intent(request)
