"""Wallet, tag, and API-token authentication for the trade-executor.

Fail-closed defaults (override explicitly for local grace):
  ENFORCE_WALLET_AUTH=1
  ENFORCE_WRITE_CHALLENGE=1
"""
from __future__ import annotations

from functools import wraps
from flask import request, jsonify, g
from eth_account import Account
from eth_account.messages import encode_defunct

from session_key import SESSION_HEADER, delegated_signer_authorizes
import hashlib
import hmac
import json
import logging
import os
import time

from challenge_store import LEGACY, issue_challenge, take_challenge

# main's strategy-signing constants (used below at the create-strategy sig check) — kept alongside
# the PR branch's write-challenge auth.
SIGN_MESSAGE_STRATEGY = "Siphon create strategy v1"
MAX_AGE_SECONDS = 300

SIGN_MESSAGE = "Siphon auth v1"
WRITE_MESSAGE_PREFIX = "Siphon auth v1:write:"  # legacy, unbound — see write_message()
WRITE_MESSAGE_V2_PREFIX = "Siphon auth v2:write:"
HMAC_AUTH_MSG = "siphon-auth-v1"
HMAC_AUTH_MSG_V2 = "siphon-auth-v2"
SIGN_MESSAGE_NOTES = "Siphon notes auth v1"

_auth_log = logging.getLogger("siphon.auth")


def _env_flag(name: str, default: str = "1") -> bool:
    return (os.getenv(name, default) or default).strip() == "1"


def enforce_wallet_auth() -> bool:
    """Ownership + gated-route auth. Default ON (fail closed). Set =0 only for local grace."""
    return _env_flag("ENFORCE_WALLET_AUTH", "1")


def enforce_write_challenge() -> bool:
    return _env_flag("ENFORCE_WRITE_CHALLENGE", "1")


def require_write_chain() -> bool:
    """Refuse unbound (v1) write challenges. Default ON; set =0 only while clients roll out."""
    return _env_flag("WRITE_CHALLENGE_REQUIRE_CHAIN", "1")


def write_auth_chain_ids() -> set[int]:
    """Chains THIS executor issues write challenges for (WRITE_AUTH_CHAIN_IDS, comma list).

    Deliberately explicit per host, never derived from which vault kernels happen to be in the env:
    the Base and Arbitrum executors must serve DISJOINT sets, because the chain in the signed
    message is what stops one host replaying a user's signature at the other (OVERLORD G-8).
    Unset ⇒ no chain-bound challenges at all (fail closed).
    """
    out: set[int] = set()
    for part in (os.getenv("WRITE_AUTH_CHAIN_IDS") or "").split(","):
        part = part.strip()
        if part.isdecimal():
            out.add(int(part))
    return out


def write_message(nonce: str, chain_id: int | None) -> str:
    """The exact text a write is signed over. v2 binds the chain, and through it the host."""
    if chain_id is None:
        return f"{WRITE_MESSAGE_PREFIX}{nonce}"
    return f"{WRITE_MESSAGE_V2_PREFIX}{int(chain_id)}:{nonce}"


def enforce_read_sig_max_age() -> bool:
    return _env_flag("ENFORCE_READ_SIG_MAX_AGE", "1")


def read_sig_max_age_seconds() -> int:
    try:
        return max(60, min(int(os.getenv("READ_SIG_MAX_AGE_SECONDS", "300")), 604800))
    except ValueError:
        return 300


def tag_auth_v2_only() -> bool:
    """When True, reject legacy HMAC(tag) — require pinned TagVerifier."""
    return _env_flag("TAG_AUTH_V2_ONLY", "0")


def block_browser_executor_routes() -> bool:
    return _env_flag("BLOCK_BROWSER_EXECUTOR_ROUTES", "1")


def _audit(event: str, **fields):
    parts = [f"event={event}"]
    for k, v in fields.items():
        if v is None:
            continue
        parts.append(f"{k}={v}")
    rid = getattr(g, "request_id", None) or request.headers.get("X-Request-ID") or "-"
    parts.append(f"request_id={rid}")
    parts.append(f"path={request.path}")
    _auth_log.info(" ".join(parts))


def _hash_id(value: str) -> str:
    return hashlib.sha256((value or "").encode()).hexdigest()[:16]


def _check_wallet_sig():
    wallet = (request.headers.get("X-Wallet-Address") or "").lower()
    signature = request.headers.get("X-Signature") or ""
    timestamp = request.headers.get("X-Timestamp") or ""

    if not wallet or not signature or not timestamp:
        return None

    if enforce_read_sig_max_age():
        try:
            ts = int(timestamp)
        except ValueError:
            return None
        if abs(int(time.time()) - ts) > read_sig_max_age_seconds():
            return None

    message = f"{SIGN_MESSAGE}:{timestamp}"
    msg = encode_defunct(text=message)
    try:
        recovered = Account.recover_message(msg, signature=signature).lower()
    except Exception:
        return None
    if recovered == wallet:
        return recovered
    # Session key: the wallet delegated signing authority to an ephemeral key so the user is not
    # prompted on every request. Checked only AFTER direct recovery fails, so the existing path is
    # untouched and un-migrated clients (SDKs, agents) keep working unchanged.
    if delegated_signer_authorizes(
        request.headers.get(SESSION_HEADER), recovered, wallet
    ):
        return wallet
    return None


def _check_wallet_write_sig(*, consume: bool = True):
    wallet = (request.headers.get("X-Wallet-Address") or "").lower()
    signature = request.headers.get("X-Write-Signature") or ""
    nonce = (request.headers.get("X-Write-Nonce") or "").strip()

    if not wallet or not signature or not nonce:
        return None

    binding = take_challenge(nonce, consume=consume)
    if binding is None:
        return None
    if binding == LEGACY:
        if require_write_chain():
            return None
        message = write_message(nonce, None)
    else:
        # The chain was fixed when THIS executor issued the nonce, so a signature made for another
        # chain — i.e. another host — never verifies here.
        message = write_message(nonce, int(binding.split(":", 1)[1]))
    msg = encode_defunct(text=message)
    try:
        recovered = Account.recover_message(msg, signature=signature).lower()
    except Exception:
        return None
    if recovered == wallet:
        return recovered
    # Session key, same rule the read path already applies (see _check_wallet_sig). Without this a
    # WRITE could only ever be signed by the wallet itself, so background writes — the decryptor
    # client-key sync above all — opened a MetaMask prompt on page load for something the user
    # never clicked. The single-use challenge nonce is still consumed above, so replay protection
    # is unchanged: delegation decides WHO may sign, the nonce still decides how often.
    if delegated_signer_authorizes(
        request.headers.get(SESSION_HEADER), recovered, wallet
    ):
        return wallet
    return None


def _v1_tag_token(tag: str) -> str:
    return hmac.new(tag.encode(), HMAC_AUTH_MSG.encode(), hashlib.sha256).hexdigest()


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _lookup_tag_verifier(tag: str):
    try:
        from note_db import NoteSession, TagVerifier

        return NoteSession().query(TagVerifier).filter_by(tag=tag).first()
    except Exception:
        return None


def _upsert_tag_verifier(tag: str, token: str) -> None:
    try:
        from note_db import NoteSession, TagVerifier

        session = NoteSession()
        row = session.query(TagVerifier).filter_by(tag=tag).first()
        th = _token_hash(token)
        if row:
            # Re-bind only allowed if presenting the already-pinned token (rotation via explicit clear).
            if not hmac.compare_digest(row.token_hash, th):
                raise PermissionError("tag verifier already bound to a different token")
            return
        session.add(TagVerifier(tag=tag, token_hash=th))
        session.commit()
    except PermissionError:
        raise
    except Exception as e:
        print(f"[tag_auth] verifier upsert failed: {e}")
        raise


def _check_tag_sig():
    """Validate tag auth. No inline bind — pinning only via POST /auth/tag-bind."""
    tag = (request.headers.get("X-Tag") or "").lower()
    auth_token = (request.headers.get("X-Auth-Token") or "").lower()

    if not tag or not auth_token:
        return None

    verifier = _lookup_tag_verifier(tag)
    if verifier is not None:
        if hmac.compare_digest(verifier.token_hash, _token_hash(auth_token)):
            return tag
        _audit("tag_auth_fail", reason="verifier_mismatch", tag_hash=_hash_id(tag))
        return None

    if tag_auth_v2_only():
        _audit("tag_auth_fail", reason="v2_only_unbound", tag_hash=_hash_id(tag))
        return None

    # Legacy v1 — forgeable if tag leaks; disabled when TAG_AUTH_V2_ONLY=1
    expected_v1 = _v1_tag_token(tag)
    if hmac.compare_digest(expected_v1, auth_token):
        return tag

    _audit("tag_auth_fail", reason="invalid_token", tag_hash=_hash_id(tag))
    return None


def verify_wallet_sig(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        wallet = _check_wallet_sig() or _solana_devnet_read_open()
        if not wallet:
            _audit("wallet_sig_fail", mode="read")
            return jsonify({"error": "Invalid or missing wallet signature"}), 401
        _audit("wallet_sig_ok", mode="read", wallet_hash=_hash_id(wallet))
        return f(*args, wallet=wallet, **kwargs)

    return decorated


def verify_wallet_sig_gated(f):
    """Require wallet sig when ENFORCE_WALLET_AUTH=1 (default)."""

    @wraps(f)
    def decorated(*args, **kwargs):
        wallet = _check_wallet_sig()
        if enforce_wallet_auth() and not wallet:
            _audit("wallet_sig_fail", mode="gated")
            return jsonify({"error": "Invalid or missing wallet signature"}), 401
        if wallet:
            _audit("wallet_sig_ok", mode="gated", wallet_hash=_hash_id(wallet))
        return f(*args, wallet=wallet, **kwargs)

    return decorated


# Phantom session for Devnet users (no EVM signer). One signMessage per session: the wallet signs
# this message with an expiry, and every request carries it. The executor never trusted the bare
# X-Solana-Address header this replaces — anyone could create, fire or abort for any Solana user.
SOLANA_SESSION_PREFIX = "Siphon devnet session v1"
SOLANA_SESSION_MAX_SEC = 24 * 3600


def solana_session_message(wallet: str, expires: int) -> bytes:
    return f"{SOLANA_SESSION_PREFIX}\nwallet:{wallet}\nexpires:{int(expires)}".encode()


def _solana_session_wallet() -> str | None:
    """The Phantom wallet a valid X-Solana-Address/-Session/-Expires set proves, or None."""
    import base64
    import time

    wallet = (request.headers.get("X-Solana-Address") or "").strip()
    sig = request.headers.get("X-Solana-Session") or ""
    try:
        expires = int(request.headers.get("X-Solana-Expires") or 0)
    except ValueError:
        return None
    now = int(time.time())
    if not wallet or wallet.startswith("0x") or not sig:
        return None
    if not now < expires <= now + SOLANA_SESSION_MAX_SEC + 60:
        return None
    try:
        from solders.pubkey import Pubkey
        from solders.signature import Signature

        ok = Signature.from_bytes(base64.b64decode(sig)).verify(
            Pubkey.from_string(wallet), solana_session_message(wallet, expires))
    except Exception:
        return None
    return wallet if ok else None


def _solana_pubkey(wallet: str) -> bool:
    if not wallet or wallet.startswith("0x"):
        return False
    try:
        from solders.pubkey import Pubkey

        Pubkey.from_string(wallet)
        return True
    except Exception:
        return False


def _gateway_solana_wallet() -> str | None:
    """A Solana wallet the API gateway already authenticated — an ed25519 v2 intent with its nonce
    consumed — asserted with the gateway's shared secret. Stands in for the Phantom session on the
    same Devnet routes, so API callers sign per request instead of holding a day-long session."""
    if not _gateway_attested():
        return None
    wallet = (request.headers.get("X-Wallet-Address") or "").strip()
    return wallet if _solana_pubkey(wallet) else None


_SOLANA_DEVNET_OPEN_RULES = frozenset({
    "/createStrategy", "/uploadServerKey", "/uploadClientKey", "/selfCheckKeys",
    "/executeStrategy", "/strategies/<strategy_id>/abort", "/solana/relayWithdraw",
})


def _solana_devnet_arm_open(data: dict | None) -> str | None:
    """Devnet writes for a Phantom-session wallet when SOLANA_DEVNET_ARM_OPEN=1.

    createStrategy (from_chain=900002) and the key/execute/abort routes, without an EVM write
    challenge. The session must be valid and, when the body names a user_id, be that user.
    """
    if not _env_flag("SOLANA_DEVNET_ARM_OPEN", "0"):
        return None
    # Only the devnet strategy/key routes. Without this the open path authorised EVERY
    # verify_wallet_write route whose body lacks from_chain — /relaySpend, /bridgeWithdraw,
    # /withdrawCredit/topup — for anyone sending a non-0x X-Solana-Address header.
    rule = getattr(request.url_rule, "rule", None)
    if rule not in _SOLANA_DEVNET_OPEN_RULES:
        return None
    body = data if isinstance(data, dict) else (request.get_json(silent=True) or {})
    user = _solana_session_wallet() or _gateway_solana_wallet()
    if not user:
        return None
    named = str(body.get("user_id") or "").strip()
    if named and named != user:
        return None
    # createStrategy must name Devnet; key upload has no from_chain — allow Solana user_id.
    if "from_chain" in body:
        try:
            if int(body.get("from_chain") or 0) != 900_002:
                return None
        except (TypeError, ValueError):
            return None
    return user


_SOLANA_DEVNET_READ_RULES = frozenset({
    "/hasClientKey/<user_id>", "/hasServerKey/<user_id>", "/strategies/<user_id>",
    "/strategy/<strategy_id>/result",
})


def _solana_devnet_read_open() -> str | None:
    """Reads for a Phantom-session wallet under SOLANA_DEVNET_ARM_OPEN=1: key presence, the
    strategy list and a strategy's result. A path user must be the session wallet; the result
    route checks the strategy's owner against it itself."""
    if not _env_flag("SOLANA_DEVNET_ARM_OPEN", "0"):
        return None
    if getattr(request.url_rule, "rule", None) not in _SOLANA_DEVNET_READ_RULES:
        return None
    user = _solana_session_wallet() or _gateway_solana_wallet()
    path_user = ((request.view_args or {}).get("user_id") or "").strip()
    if not user or (path_user and path_user != user):
        return None
    return user


def verify_wallet_write(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        wallet = _check_wallet_write_sig(consume=True)
        if wallet:
            _audit("wallet_write_ok", wallet_hash=_hash_id(wallet))
            return f(*args, wallet=wallet, **kwargs)

        sol_user = _solana_devnet_arm_open(None)
        if sol_user:
            _audit("wallet_write_ok", wallet_hash=_hash_id(sol_user), reason="solana_devnet_arm_open")
            return f(*args, wallet=sol_user, **kwargs)

        if not enforce_write_challenge():
            wallet = _check_wallet_sig()
            if enforce_wallet_auth() and not wallet:
                _audit("wallet_write_fail", reason="no_sig")
                return jsonify({"error": "Invalid or missing wallet signature"}), 401
            return f(*args, wallet=wallet, **kwargs)

        _audit("wallet_write_fail", reason="challenge")
        return jsonify({
            "error": "Write challenge required",
            "hint": "POST /auth/challenge {chain_id} then sign 'Siphon auth v2:write:<chain_id>:<nonce>'",
        }), 401

    return decorated


def _strategy_intent_message(data: dict, timestamp: str, nonce: str) -> str:
    """Rebuild the exact public-gateway v2 intent after removing gateway-only metadata."""
    client_body = {k: v for k, v in data.items() if k not in ("user_id", "billing_ref")}
    encoded = json.dumps(
        client_body,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    chain_id = client_body.get("chain_id", client_body.get("from_chain", ""))
    return "\n".join(
        (
            "Siphon API v2",
            f"chain_id:{chain_id}",
            f"timestamp:{timestamp}",
            f"nonce:{nonce}",
            "method:POST",
            "path:/v1/strategies",
            f"body_sha256:{digest}",
        )
    )


def _gateway_attested() -> bool:
    """True when this request carries the gateway's shared-secret attestation header.

    Only the api-gateway can produce it (`require_siphon_user_api_key` checks the same value), so
    it is the marker that separates gateway-forwarded traffic from a direct browser submission.
    """
    token = request.headers.get("X-Siphon-Gateway-Token") or ""
    return any(hmac.compare_digest(token, accepted) for accepted in _accepted_api_tokens())


def verify_strategy_sig(f):
    """Verify the gateway's exact client-body signature at the executor trust boundary.

    `user_id` and `billing_ref` are authenticated gateway metadata added after the client signs;
    every client-controlled strategy field remains covered by the same v2 EIP-191 intent that the
    gateway verified and replay-protected.

    The v2 intent is a GATEWAY artifact: only an SDK/API client signs it, and only the gateway
    forwards it (`routers/strategies._wallet_headers`). The dapp submits to /createStrategy
    directly and authenticates with the write challenge instead, so demanding both here 401'd
    every browser arm ("Fresh strategy-bound wallet signature required"). Enforce it on the
    traffic that can actually carry it and let `verify_wallet_write` — next in the stack, and
    never skipped — gate the rest. When REQUIRE_USER_API_KEY is on (the default),
    `require_siphon_user_api_key` has already rejected anything without the attestation, so this
    is a no-op there and direct submission stays closed.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if not _gateway_attested():
            return f(*args, **kwargs)
        raw_wallet = (request.headers.get('X-Wallet-Address') or '').strip()
        solana = _solana_pubkey(raw_wallet)
        wallet = raw_wallet if solana else raw_wallet.lower()
        signature = request.headers.get('X-Signature') or ''
        raw_timestamp = request.headers.get('X-Timestamp') or ''
        nonce = request.headers.get('X-Nonce') or ''
        try:
            timestamp = int(raw_timestamp)
        except (TypeError, ValueError):
            timestamp = 0
        if (
            not wallet
            or not signature
            or not nonce
            or abs(int(time.time()) - timestamp) > MAX_AGE_SECONDS
        ):
            return jsonify({"error": "Fresh strategy-bound wallet signature required"}), 401
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({"error": "Invalid strategy JSON"}), 400
        try:
            message = _strategy_intent_message(data, raw_timestamp, nonce)
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid strategy JSON"}), 400
        if solana:
            # A Solana wallet signs the same intent with ed25519 (base64), as the gateway verified.
            try:
                import base64
                from solders.pubkey import Pubkey
                from solders.signature import Signature

                ok = Signature.from_bytes(base64.b64decode(signature, validate=True)).verify(
                    Pubkey.from_string(wallet), message.encode("utf-8"))
            except Exception:
                ok = False
            recovered = wallet if ok else ""
        else:
            try:
                recovered = Account.recover_message(
                    encode_defunct(text=message), signature=signature
                ).lower()
            except Exception:
                recovered = ""
        if recovered != wallet:
            return jsonify({"error": "Invalid strategy-bound wallet signature"}), 401
        return f(*args, **kwargs)
    return decorated


def verify_tag_sig(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        from auth import check_rate_limit

        tag = _check_tag_sig()
        if not tag:
            check_rate_limit(30, 60, bucket="tag_auth_fail")
            hint = None
            if tag_auth_v2_only():
                hint = "Tag must be bound via POST /auth/tag-bind (TAG_AUTH_V2_ONLY=1)"
            body = {"error": "Invalid or missing tag signature"}
            if hint:
                body["hint"] = hint
            return jsonify(body), 401
        _audit("tag_auth_ok", tag_hash=_hash_id(tag))
        return f(*args, tag=tag, **kwargs)

    return decorated


def _accepted_api_tokens():
    return {t for t in (os.getenv("API_TOKEN", ""), os.getenv("API_TOKEN_OLD", "")) if t}


def _api_token_ok(token):
    accepted = _accepted_api_tokens()
    return bool(token) and token in accepted


def _extract_api_token():
    return request.headers.get("X-API-TOKEN") or request.headers.get("Authorization", "").replace(
        "Bearer ", ""
    )


def _looks_like_browser_call() -> bool:
    """True when the request carries a browser Origin (executor routes must not be callable from pages)."""
    origin = (request.headers.get("Origin") or "").strip()
    if not origin:
        # Sec-Fetch-Site: cross-site / same-origin from navigations
        sfs = (request.headers.get("Sec-Fetch-Site") or "").lower()
        if sfs in ("same-origin", "same-site", "cross-site"):
            return True
        return False
    return True


def require_api_token(f):
    """Executor-only. Rejects browser Origins when BLOCK_BROWSER_EXECUTOR_ROUTES=1 (default)."""

    @wraps(f)
    def decorated(*args, **kwargs):
        if block_browser_executor_routes() and _looks_like_browser_call():
            _audit("executor_route_blocked_browser")
            return jsonify({
                "error": "Executor routes are not callable from browsers",
                "hint": "Call from the trade-executor / relayer backend only",
            }), 403
        token = _extract_api_token()
        if not _accepted_api_tokens() or not _api_token_ok(token):
            _audit("api_token_fail")
            return jsonify({"error": "Invalid or missing API token"}), 401
        _audit("api_token_ok", scope="executor")
        return f(*args, **kwargs)

    return decorated


def require_api_token_or_wallet(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = _extract_api_token()
        if _api_token_ok(token):
            if block_browser_executor_routes() and _looks_like_browser_call():
                # Browser must not use API token path; fall through to wallet
                pass
            else:
                _audit("api_token_ok", scope="executor_or_wallet")
                return f(*args, wallet=None, **kwargs)

        wallet = _check_wallet_write_sig(consume=True)
        if not wallet and not enforce_write_challenge():
            wallet = _check_wallet_sig()

        if wallet:
            _audit("wallet_sig_ok", mode="executor_or_wallet", wallet_hash=_hash_id(wallet))
            return f(*args, wallet=wallet, **kwargs)

        _audit("auth_fail", mode="executor_or_wallet")
        return jsonify({"error": "Authentication required"}), 401

    return decorated


def reject_api_token_on_user_routes(f):
    """Reject any API-token channel on user-owned routes (header presence, not validity)."""

    @wraps(f)
    def decorated(*args, **kwargs):
        if request.headers.get("X-API-TOKEN"):
            _audit("api_token_rejected_on_user_route", reason="x_api_token_header")
            return jsonify({
                "error": "API token is not accepted on user routes; use wallet authentication",
            }), 403
        auth = request.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer ") and not (
            request.headers.get("X-Signature") or request.headers.get("X-Write-Signature")
        ):
            _audit("api_token_rejected_on_user_route", reason="bearer_only")
            return jsonify({
                "error": "API token is not accepted on user routes; use wallet authentication",
            }), 403
        return f(*args, **kwargs)

    return decorated


def require_siphon_user_api_key(f):
    """Require a dashboard API key (sk_live_/sk_test_) validated via the API gateway.

    Used on createStrategy together with wallet write auth. Service X-API-TOKEN is rejected.
    Set REQUIRE_USER_API_KEY=0 to disable (local-only escape hatch).

    Solana Devnet browser arms (Phantom session + SOLANA_DEVNET_ARM_OPEN + from_chain=900002)
    skip the gateway key: the dapp talks to the executor directly; wallet write auth still runs.
    """

    @wraps(f)
    def decorated(*args, **kwargs):
        require = os.getenv("REQUIRE_USER_API_KEY", "1").strip().lower() not in (
            "0",
            "false",
            "no",
            "off",
        )
        if not require:
            return f(*args, **kwargs)

        # Phantom Devnet product path — same open rules as verify_wallet_write.
        if _solana_devnet_arm_open(None):
            _audit("user_api_key_ok", reason="solana_devnet_arm_open")
            return f(*args, **kwargs)

        # Session present but not authorized for this body (wrong user_id / not Devnet):
        # fail as wallet auth, not as "must use the API gateway".
        if (
            _env_flag("SOLANA_DEVNET_ARM_OPEN", "0")
            and _solana_session_wallet()
            and getattr(request.url_rule, "rule", None) == "/createStrategy"
        ):
            body = request.get_json(silent=True) or {}
            try:
                is_devnet = int(body.get("from_chain") or 0) == 900_002
            except (TypeError, ValueError):
                is_devnet = False
            if is_devnet:
                _audit("user_api_key_fail", reason="solana_session_not_authorized")
                return jsonify({"error": "Invalid or missing wallet signature"}), 401

        if request.headers.get("X-API-TOKEN"):
            _audit("user_api_key_fail", reason="x_api_token_not_allowed")
            return jsonify({
                "error": "X-API-TOKEN is not valid for createStrategy; use Authorization: Bearer <sk_…>",
            }), 403

        gateway_token = request.headers.get("X-Siphon-Gateway-Token") or ""
        if not any(
            hmac.compare_digest(gateway_token, accepted) for accepted in _accepted_api_tokens()
        ):
            _audit("user_api_key_fail", reason="gateway_attestation")
            return jsonify({
                "error": "createStrategy must be submitted through the Siphon API gateway",
            }), 403

        auth = (request.headers.get("Authorization") or "").strip()
        if not auth.lower().startswith("bearer "):
            _audit("user_api_key_fail", reason="missing_bearer")
            return jsonify({
                "error": "Siphon API key required",
                "hint": "Set Authorization: Bearer sk_live_… (from dashboard API Keys / Install MCP)",
            }), 401

        token = auth[7:].strip()
        if not (token.startswith("sk_live_") or token.startswith("sk_test_")):
            _audit("user_api_key_fail", reason="not_sk_prefix")
            return jsonify({
                "error": "Authorization must be a Siphon dashboard API key (sk_live_/sk_test_)",
            }), 401

        gateway = (
            os.getenv("SIPHON_API_GATEWAY_URL")
            or os.getenv("API_GATEWAY_URL")
            or ""
        ).rstrip("/")
        if not gateway:
            _audit("user_api_key_fail", reason="gateway_url_unset")
            return jsonify({
                "error": "Server misconfigured: SIPHON_API_GATEWAY_URL not set",
            }), 503

        try:
            import json as _json
            import urllib.request

            req = urllib.request.Request(
                f"{gateway}/v1/keys/verify",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"verify status {resp.status}")
                payload = _json.loads(resp.read().decode("utf-8") or "{}")
                if not payload.get("ok"):
                    raise RuntimeError("verify not ok")
                key_id = str(payload.get("api_key_id") or "")
        except Exception as e:
            _audit("user_api_key_fail", reason="verify_failed", detail=str(e)[:120])
            return jsonify({
                "error": "Invalid or revoked Siphon API key",
                "hint": "Buy or refresh a key in the Siphon dashboard, then set SIPHON_API_KEY in MCP",
            }), 401

        _audit("user_api_key_ok", api_key_id_hash=_hash_id(key_id or token[:16]))
        return f(*args, **kwargs)

    return decorated


def create_challenge_payload(chain_id=None):
    """A write challenge. With `chain_id` (required once WRITE_CHALLENGE_REQUIRE_CHAIN=1) it is
    bound to that chain, which must be one this executor serves. Raises ValueError otherwise."""
    if chain_id is None:
        if require_write_chain():
            raise ValueError("chain_id is required: sign 'Siphon auth v2:write:<chain_id>:<nonce>'")
        payload = issue_challenge()
        payload["message"] = write_message(payload["nonce"], None)
        return payload
    try:
        cid = int(chain_id)
    except (TypeError, ValueError):
        raise ValueError("chain_id must be an integer")
    if isinstance(chain_id, bool) or cid not in write_auth_chain_ids():
        raise ValueError(f"this executor does not serve chain {chain_id}; served: {sorted(write_auth_chain_ids())}")
    payload = issue_challenge(chain_id=cid)
    payload["message"] = write_message(payload["nonce"], cid)
    return payload
