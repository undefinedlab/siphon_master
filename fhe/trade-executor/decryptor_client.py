"""HTTP client for the confidential-vm siphon-decryptor service.

The decryptor holds each user's tfhe ClientKey and returns only the decrypted trigger bit.
Called from the scheduler (internal VPC); never exposes decrypted strategy inputs.
"""
import os
from typing import Optional, Tuple

import requests

DECRYPTOR_URL = (os.getenv("DECRYPTOR_URL") or "").rstrip("/")
DECRYPTOR_TIMEOUT = int(os.getenv("DECRYPTOR_TIMEOUT", "60"))
# Shared secret for the decryptor's protected routes (/clientKey, /decrypt). Must match the
# decryptor's DECRYPTOR_AUTH_TOKEN. Empty => header omitted (decryptor then runs unauthenticated).
DECRYPTOR_AUTH_TOKEN = os.getenv("DECRYPTOR_AUTH_TOKEN", "")


def _auth_headers() -> dict:
    return {"X-Decryptor-Token": DECRYPTOR_AUTH_TOKEN} if DECRYPTOR_AUTH_TOKEN else {}


def decryptor_enabled() -> bool:
    return bool(DECRYPTOR_URL)


# EVM addresses are case-insensitive; Solana base58 pubkeys are case-sensitive. The decryptor's
# in-memory map is case-sensitive, so only fold 0x… ids — lowercasing a Phantom id would store the
# ClientKey under a different key than Strategy.user_id and the trigger would never decrypt.
def _norm_user(user_id: str) -> str:
    uid = (user_id or "").strip()
    return uid.lower() if uid.startswith("0x") else uid


def upload_client_key(user_id: str, client_key_hex: str) -> dict:
    """Forward a (dev: plaintext hex) ClientKey to the decryptor. Used by the browser proxy."""
    if not DECRYPTOR_URL:
        return {"ok": False, "error": "DECRYPTOR_URL not configured"}
    r = requests.post(
        f"{DECRYPTOR_URL}/clientKey",
        json={"user_id": _norm_user(user_id), "client_key": client_key_hex},
        headers=_auth_headers(),
        timeout=DECRYPTOR_TIMEOUT,
    )
    try:
        body = r.json()
    except Exception:
        body = {"ok": False, "error": r.text[:500]}
    if not r.ok:
        body.setdefault("error", f"HTTP {r.status_code}")
    return body


def get_attestation() -> dict:
    """Fetch the decryptor's TDX quote + enclave x25519 pubkey (browser verifies, then seals
    the ClientKey to that pubkey). Pass-through — the executor is NOT a trust point here."""
    if not DECRYPTOR_URL:
        return {"error": "DECRYPTOR_URL not configured"}
    try:
        r = requests.get(f"{DECRYPTOR_URL}/attestation", timeout=DECRYPTOR_TIMEOUT)
        return r.json()
    except Exception as e:
        return {"error": f"decryptor attestation unreachable: {e}"}


def has_client_key(user_id: str) -> bool:
    if not DECRYPTOR_URL:
        return False
    try:
        r = requests.get(
            f"{DECRYPTOR_URL}/hasClientKey/{_norm_user(user_id)}",
            headers=_auth_headers(),
            timeout=10,
        )
        if r.ok:
            body = r.json()
            # An auth failure comes back 200 {"has_key": false, "error": …} — say so, or it reads as "no key".
            if body.get("error"):
                print(f"[Decryptor] hasClientKey error for {user_id[:10]}…: {body['error']}")
            return bool(body.get("has_key"))
    except Exception as e:
        print(f"[Decryptor] hasClientKey failed for {user_id[:10]}…: {e}")
    return False


def verify_canary(user_id: str, canary_hex: str, server_key: str) -> Tuple[bool, Optional[str]]:
    """Decrypt-time key-consistency gate. Proves the three keys — the ClientKey the bounds were
    encrypted under, the engine ServerKey, and the decryptor's ClientKey — are ONE generation, at
    the moment of use (not just at arm time). Evaluates the user's stored canary = encrypt(0) through
    the engine (0 <= 100 → known-answer TRUE) with `server_key`, then decrypts it via the decryptor.
    Returns (consistent, error); consistent is True ONLY if it decrypts to exactly True. If any key
    drifted after arming, this returns False and the scheduler must NOT fire (fail closed)."""
    if not DECRYPTOR_URL:
        return True, None  # no server-side decrypt path → nothing to verify
    if not canary_hex or not server_key:
        return False, "missing canary or server_key"
    import fhe_client  # lazy: avoid import cycle (fhe_client has no dep on this module)
    try:
        er = fhe_client.post_engine({
            "strategy_type": "TWAP_SLICE", "encrypted_upper_bound": "",
            "encrypted_lower_bound": canary_hex,
            "current_price_cents": 0, "current_time": 100,  # 0 <= 100 → TRUE
        }, server_key, timeout=120)
        enc = (er or {}).get("encrypted_result")
    except Exception as e:
        return False, f"engine: {e}"
    if not enc:
        return False, "engine: no canary result"
    triggered, err = decrypt_trigger(user_id, enc)
    return (triggered is True), err


def decrypt_trigger(user_id: str, encrypted_result_hex: str) -> Tuple[Optional[bool], Optional[str]]:
    """Decrypt the FHE engine's encrypted 0/1 result. Returns (triggered, error)."""
    if not DECRYPTOR_URL:
        return None, "DECRYPTOR_URL not configured"
    try:
        r = requests.post(
            f"{DECRYPTOR_URL}/decrypt",
            json={"user_id": _norm_user(user_id), "encrypted_result": encrypted_result_hex},
            headers=_auth_headers(),
            timeout=DECRYPTOR_TIMEOUT,
        )
        body = r.json()
        if not r.ok:
            return None, body.get("error") or f"HTTP {r.status_code}"
        if body.get("error"):
            return None, body["error"]
        triggered = body.get("triggered")
        if triggered is None:
            return None, "missing triggered field"
        return bool(triggered), None
    except Exception as e:
        return None, str(e)


# ─────────────────────────────────────────────────────────────────────────────────────────────
# v3 fire-time spend
#
# A v2 leg ships a finished Groth16 proof built in the browser at arming time. A v3 leg cannot:
# the circuit binds admittedRoot/revokedRoot as public inputs, so a proof built at arming is
# stale long before the trigger fires. Instead the browser seals the note secrets to the
# enclave's attested x25519 key, and the enclave builds the proof when the trigger fires.
#
# The executor is a pure conduit here. It never sees a note secret (the arm payload is sealed to
# the enclave, not to us) and it never learns which note a leg spends.
# ─────────────────────────────────────────────────────────────────────────────────────────────

# Proving is heavier than a trigger decrypt: rapidsnark on a 2-vCPU CVM is well under a second
# for a swap leg, but the ASP sync in front of it dominates and grows with the admitted set.
SPEND_PROVE_TIMEOUT = int(os.getenv("SPEND_PROVE_TIMEOUT", "180"))


def arm_spend_leg(payload: dict) -> Tuple[Optional[str], Optional[str]]:
    """Hand one sealed, armed leg to the enclave. Returns (legKey, error).

    `payload` is passed through verbatim — it is ciphertext sealed to the enclave, so the
    executor cannot inspect or usefully validate it, and re-encoding risks corrupting it.
    """
    if not DECRYPTOR_URL:
        return None, "DECRYPTOR_URL not configured"
    try:
        r = requests.post(
            f"{DECRYPTOR_URL}/spend/arm",
            json=payload,
            headers=_auth_headers(),
            timeout=DECRYPTOR_TIMEOUT,
        )
        body = r.json()
        if not r.ok or body.get("error"):
            return None, body.get("error") or f"HTTP {r.status_code}"
        return body.get("legKey"), None
    except Exception as e:
        return None, str(e)


def prove_spend_leg(strategy_id: str, leg_index: int) -> Tuple[Optional[dict], Optional[str]]:
    """Ask the enclave to prove + attest one armed leg. Returns (result, error).

    On success `result` carries everything `VaultKernel.spendAttested` needs:
        proof[8], publicSignals[25], attestationExpiry, attesterSig

    The attestation is the enclave vouching that the spent note is not revoked as of a CURRENT
    ASP snapshot. The proof alone cannot say that: it proves non-inclusion in the revoked root it
    was built against, and the hub accepts any once-published revoked root, so without the
    attestation a leg could prove against a stale set. See ComplianceHub.verifyFreshness.

    `retryable` distinguishes "the ASP snapshot was stale, try again next tick" from a permanent
    failure — the caller must not burn the leg on the former.
    """
    if not DECRYPTOR_URL:
        return None, "DECRYPTOR_URL not configured"
    try:
        r = requests.post(
            f"{DECRYPTOR_URL}/spend/prove",
            json={"strategyId": strategy_id, "legIndex": int(leg_index)},
            headers=_auth_headers(),
            timeout=SPEND_PROVE_TIMEOUT,
        )
        body = r.json()
    except Exception as e:
        # A network failure is always worth retrying; the leg is still armed in the enclave.
        return None, f"retryable: {e}"

    if not r.ok or not body.get("ok"):
        err = body.get("error") or f"HTTP {r.status_code}"
        return None, (f"retryable: {err}" if body.get("retryable") else err)

    # rawPayee comes from the enclave because only it holds the leg's public half; the executor
    # never saw it. For a swap leg it is 20 zero bytes (settlement goes to the pool, not a payee).
    missing = [k for k in ("proof", "publicSignals", "rawPayee", "attestationExpiry", "attesterSig")
               if body.get(k) in (None, "")]
    if missing:
        # Refuse to submit half an answer: without the signature the kernel reverts with
        # AttesterUnset/BadSignature and the gas is wasted.
        return None, f"enclave response missing {', '.join(missing)}"
    return body, None


def disarm_spend_leg(strategy_id: str, leg_index: int) -> Optional[str]:
    """Drop an armed leg's sealed secrets from the enclave. Returns an error string or None."""
    if not DECRYPTOR_URL:
        return "DECRYPTOR_URL not configured"
    try:
        r = requests.post(
            f"{DECRYPTOR_URL}/spend/disarm",
            json={"strategyId": strategy_id, "legIndex": int(leg_index)},
            headers=_auth_headers(),
            timeout=DECRYPTOR_TIMEOUT,
        )
        return None if r.ok else (r.json().get("error") or f"HTTP {r.status_code}")
    except Exception as e:
        return str(e)


# Proving a 6-input spend with rapidsnark on a 2-vCPU CVM is seconds, not milliseconds, and the
# request also carries the witness up. Kept separate from DECRYPTOR_TIMEOUT so raising it does not
# also stretch the trigger-decrypt path, which must stay tight.
DECRYPTOR_PROVE_TIMEOUT = int(os.getenv("DECRYPTOR_PROVE_TIMEOUT", "180"))


def prove_witness(witness: dict) -> dict:
    """Forward a PROTOCOL witness to the enclave prover and return {proof, publicSignals}.

    The witness holds note secrets. This process is a pass-through: it must not log the body, and
    it must not persist it. The circuit is chosen inside the enclave from the witness itself, so
    there is nothing here to validate or pick.
    """
    if not DECRYPTOR_URL:
        return {"ok": False, "error": "DECRYPTOR_URL not configured"}
    try:
        r = requests.post(
            f"{DECRYPTOR_URL}/prove",
            json=witness,
            headers=_auth_headers(),
            timeout=DECRYPTOR_PROVE_TIMEOUT,
        )
    except requests.RequestException as e:
        # Retryable so the browser falls back to local proving rather than failing the withdrawal.
        return {"ok": False, "error": f"decryptor unreachable: {e}", "retryable": True}
    try:
        body = r.json()
    except ValueError:
        body = {"ok": False, "error": r.text[:500]}
    if not r.ok:
        body.setdefault("error", f"HTTP {r.status_code}")
        body.setdefault("retryable", True)
    return body
