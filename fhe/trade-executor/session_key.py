"""
Session-key delegation — server half.

The browser mints an ephemeral keypair, has the wallet sign ONE delegation authorizing it, then
signs per-request auth messages with the session key instead of prompting the wallet every time.
This module lets the executor accept those signatures.

WHY THE DELEGATION ARRIVES ON EVERY REQUEST
There is no shared session store between the browser, the Next app and this service, and the Next
routes run in Lambdas with no state at all. So the delegation travels in a header and is verified
cryptographically each time — two signature recoveries, no lookup, nothing to keep in sync:

    wallet --signs--> delegation(session_address, expiry) --signs--> per-request message

The delegation is NOT a secret. It is sent openly on every request, so possessing one must not be
enough to impersonate anyone: the request signature itself has to come from the delegated key.
That is why callers pass the recovered signer in and we compare against `session_address`.

WHAT A SESSION KEY CANNOT DO
  - It never signs key-derivation messages. The AES key protecting note backups is derived from a
    WALLET signature and must stay reproducible from the wallet alone on any device, or a user who
    clears their browser cannot recover their notes.
  - It cannot move funds. Spending is authorized by a Groth16 proof in VaultKernel.spend().

MUST STAY IN SYNC with siphon-app/src/lib/sessionKey.ts. The signed message is byte-compared, so
any divergence in field order, labels or whitespace silently rejects every session — which looks
like "sessions don't work" rather than "the two files disagree".
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

from eth_account import Account
from eth_account.messages import encode_defunct

SESSION_DELEGATION_PREFIX = "Siphon session key v1"
SESSION_HEADER = "X-Session-Delegation"
# Hard cap, mirroring the client. A delegation asserting a longer life is rejected even when its
# signature is perfectly valid — otherwise a tampered blob could claim a ten-year expiry and pass.
SESSION_MAX_AGE_SEC = 24 * 60 * 60
# Same skew tolerance the existing timestamp checks use.
_CLOCK_SKEW_SEC = 120

# Origin and chain binding. Both values live INSIDE the signed message, so they cannot be tampered
# with — but being unforgeable is not the same as being checked. Without pinning, a delegation the
# user legitimately signed on some other origin (a staging deploy, a preview URL, a look-alike that
# phished one signature) is accepted here, because its signature is perfectly valid for the wallet
# it names. Pinning is what turns "this delegation is genuine" into "this delegation is for us".
#
# Unset -> no constraint, which is the right default for local development where the origin is
# localhost:3000 and there is no single correct answer. SET THESE IN PRODUCTION.
#
# Comma-separated, because the app is served from more than one host: the delegation records
# window.location.host, so a visitor on www.siphon.money mints "www.siphon.money" and one on the
# apex mints "siphon.money". Pinning a single value would hard-401 every visitor on the other
# host with no fallback — the client has already signed and does not know to retry with the
# wallet. Caddy allows both origins for the same reason.
_EXPECTED_DOMAINS = {
    h.strip().lower()
    for h in (os.environ.get("SESSION_EXPECTED_DOMAIN") or "").split(",")
    if h.strip()
}
_EXPECTED_CHAIN_ID = (os.environ.get("SESSION_EXPECTED_CHAIN_ID") or "").strip()


def build_delegation_message(d: dict[str, Any]) -> str:
    """Reconstruct the exact text the wallet signed. Byte-identical to the TS builder."""
    issued = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(int(d["issuedAt"]))) + ".000Z"
    expires = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(int(d["expiresAt"]))) + ".000Z"
    return "\n".join([
        SESSION_DELEGATION_PREFIX,
        "",
        "I authorize the session key below to authenticate API requests on my behalf.",
        "",
        "This does NOT authorize spending, withdrawing, or moving any funds.",
        "Moving funds requires a zero-knowledge proof, which this key cannot produce.",
        "",
        f"Session key: {d['sessionAddress']}",
        f"Wallet:      {d['wallet']}",
        f"Domain:      {d['domain']}",
        f"Chain:       {d['chainId']}",
        f"Issued:      {issued}",
        f"Expires:     {expires}",
        f"Nonce:       {d['nonce']}",
    ])


def verify_delegation(raw: str, *, now: int | None = None) -> dict[str, str] | None:
    """Validate a delegation blob.

    Returns {"wallet", "session_address"} or None. The caller MUST still check that the returned
    wallet matches the wallet the request claims to be — this only proves the blob is internally
    consistent and signed by the wallet it names.
    """
    now = int(time.time()) if now is None else now
    try:
        d = json.loads(raw)
    except Exception:
        return None
    if not isinstance(d, dict):
        return None

    for field in ("sessionAddress", "wallet", "signature", "issuedAt", "expiresAt", "nonce",
                  "domain", "chainId"):
        if field not in d:
            return None

    wallet = str(d["wallet"]).lower()
    session_address = str(d["sessionAddress"])
    if not wallet.startswith("0x") or len(wallet) != 42:
        return None
    if not session_address.lower().startswith("0x") or len(session_address) != 42:
        return None

    # Reject a delegation minted for a different origin or chain before spending a recovery on it.
    if _EXPECTED_DOMAINS and str(d.get("domain", "")).strip().lower() not in _EXPECTED_DOMAINS:
        return None
    if _EXPECTED_CHAIN_ID:
        try:
            if int(d["chainId"]) != int(_EXPECTED_CHAIN_ID):
                return None
        except (TypeError, ValueError):
            return None

    try:
        issued_at = int(d["issuedAt"])
        expires_at = int(d["expiresAt"])
    except (TypeError, ValueError):
        return None

    if expires_at <= now:
        return None
    if issued_at > now + _CLOCK_SKEW_SEC:
        return None
    # Self-extended lifetime: the signature may be genuine, the claim is not acceptable.
    if expires_at - issued_at > SESSION_MAX_AGE_SEC + 60:
        return None

    try:
        recovered = Account.recover_message(
            encode_defunct(text=build_delegation_message(d)),
            signature=d["signature"],
        ).lower()
    except Exception:
        return None
    if recovered != wallet:
        return None

    return {"wallet": wallet, "session_address": session_address.lower()}


def delegated_signer_authorizes(
    raw_delegation: str | None,
    recovered_signer: str,
    claimed_wallet: str,
    *,
    now: int | None = None,
) -> bool:
    """True when `recovered_signer` is a session key that `claimed_wallet` delegated to.

    `recovered_signer` is whoever actually signed the request. Requiring it to equal the
    delegation's session address is what stops a passively-observed delegation from being replayed
    by someone who does not hold the corresponding private key.
    """
    if not raw_delegation:
        return False
    d = verify_delegation(raw_delegation, now=now)
    if not d:
        return False
    if d["wallet"] != (claimed_wallet or "").lower():
        return False
    return d["session_address"] == (recovered_signer or "").lower()
