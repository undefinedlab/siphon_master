"""Shielded Keeper — enclave custody of managed-account note material.

WHY THIS EXISTS
---------------
`POST /v1/deposits` takes `precommitment` from the caller, so an integrator must generate note
secrets, run BN254 Poseidon, build Merkle proofs and produce Groth16 proofs themselves. That is a
cryptography project, not an API integration, and it is the single reason a business cannot use
Siphon through HTTP alone. This service moves that work inside the enclave so the gateway can offer
managed accounts.

THE BOUNDARY (the only thing that really matters here)
------------------------------------------------------
`nullifier` and `secret` NEVER leave this process. Callers receive `precommitment`, `commitment`,
`nullifier_hash` — public values that are already on-chain or in a public tree. The gateway, its
database, its logs, and its backups therefore never contain spendable material. Anything that would
return a secret is a bug, and `_PUBLIC_ONLY` below is the enforcement point.

WHY DETERMINISTIC DERIVATION
----------------------------
The dapp uses `crypto.randomBytes` for note secrets, so a lost note record strands funds — a failure
this codebase has already hit. Here every note is `HKDF(master, account) -> H(seed, field, index)`,
so master key + account_ref + index reconstructs it exactly. A lost database becomes an availability
problem instead of a loss of funds.

MASTER KEY
----------
dstack KMS, derived INSIDE the enclave, never persisted — the same discipline as order-signer.py.
`KMS_KEY_PATH` is fixed: changing it changes every derived note for every account, which would
strand every managed deposit ever made. The env fallback is LOCAL DEV ONLY and refuses to run when
SIPHON_ENV is production.
"""
from __future__ import annotations

import hashlib
import logging
import os

from flask import Flask, jsonify, request

import derive
import poseidon

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("keeper")

app = Flask(__name__)

# Fixed forever: changing this re-derives every account and strands every existing managed deposit.
KMS_KEY_PATH = os.environ.get("KMS_KEY_PATH", "siphon/managed/shielded-v1")
AUTH_TOKEN = os.environ.get("KEEPER_API_TOKEN", "")
SIPHON_ENV = (os.environ.get("SIPHON_ENV") or "dev").strip().lower()
IS_PROD = SIPHON_ENV in {"prod", "production"}

_master_cache: list[bytes] = []
_master_source: list[str] = []

# Field names this service is permitted to return. A response is filtered through this set so a
# future edit cannot leak `nullifier`/`secret` by accident.
_PUBLIC_ONLY = {
    "account_id", "account_ref", "fingerprint", "index", "precommitment", "commitment",
    "nullifier_hash", "label", "amount", "chain_id", "asset", "scope", "nonce",
    # The account's EVM ADDRESS is public (it is a payout destination and a DepositInfo.depositor);
    # the private key behind it never leaves this process.
    "owner_address",
}


def _in_tee() -> tuple[bool, str]:
    """Can we actually attest that this process runs inside a CVM?

    This is the load-bearing check for the imported-secret path. An imported CVM secret arrives as
    an ordinary environment variable, so from inside the process it is INDISTINGUISHABLE from a
    plaintext env var on someone's laptop. Without proving we are in a TEE, "encrypted CVM secret"
    is a claim about deployment, not a property of the running system. Obtaining a quote is the
    difference between the two.
    """
    try:
        from dstack_sdk import DstackClient

        DstackClient().get_quote(b"siphon-keeper-boot")
        return True, "attested"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def _app_id() -> str | None:
    """The CVM app_id. dstack KMS keys are deterministic per app_id, so this is the value that
    silently invalidates a KMS-derived master when a CVM is redeployed as a NEW app."""
    try:
        from dstack_sdk import DstackClient

        info = DstackClient().info()
        return getattr(info, "app_id", None) or (info or {}).get("app_id")
    except Exception:  # noqa: BLE001
        return None


def master_fingerprint(master: bytes) -> str:
    """Non-reversible identity of the loaded master key.

    The one number ops must check after every redeploy. If it changes, every managed note derived
    under the old master is underivable — and the failure is otherwise silent until a customer
    tries to withdraw.
    """
    return hashlib.sha256(b"keeper-master-fingerprint|" + master).hexdigest()[:32]


def _load_master() -> tuple[bytes, str]:
    """Resolve the master seed. Returns (master, source).

    Precedence, and why:

    1. `KEEPER_MASTER_SECRET` — an imported, encrypted CVM secret. PREFERRED, because it survives an
       app_id change. A KMS-derived key does not, and losing it makes every managed note in every
       account permanently underivable. In production this path additionally REQUIRES an attested
       TEE, since otherwise it is just an env var.
    2. dstack KMS — works, but is bound to app_id. Accepted with a loud warning.
    3. `KEEPER_MASTER_KEY` — local dev only, refused in production.
    """
    imported = (os.environ.get("KEEPER_MASTER_SECRET") or "").strip()
    if imported:
        if IS_PROD:
            ok, detail = _in_tee()
            if not ok:
                raise RuntimeError(
                    "KEEPER_MASTER_SECRET is set but this process cannot attest to running inside a "
                    f"CVM ({detail}). Outside a TEE that value is a plaintext key on the host. "
                    "Refusing to derive note material."
                )
        raw = imported[2:] if imported.startswith("0x") else imported
        try:
            master = bytes.fromhex(raw)
        except ValueError:
            raise RuntimeError("KEEPER_MASTER_SECRET must be hex (32 bytes / 64 hex chars).")
        if len(master) < 32:
            raise RuntimeError(
                f"KEEPER_MASTER_SECRET is {len(master)} bytes; at least 32 are required."
            )
        return master, "imported-cvm-secret"

    env_key = os.environ.get("KEEPER_MASTER_KEY")
    if env_key:
        if IS_PROD:
            raise RuntimeError(
                "KEEPER_MASTER_KEY is set in production. Use KEEPER_MASTER_SECRET (an imported, "
                "encrypted CVM secret) — an env-supplied dev key is visible to the host."
            )
        log.warning("using KEEPER_MASTER_KEY from env — LOCAL DEV ONLY, not enclave-protected")
        return hashlib.sha256(env_key.encode()).digest(), "dev-env"

    from dstack_sdk import DstackClient  # imported lazily: absent outside the CVM

    master = DstackClient().get_key(KMS_KEY_PATH).decode_key()
    log.warning(
        "master derived from dstack KMS path=%s — this key is BOUND TO app_id. Redeploying as a new "
        "app changes it and makes every existing managed note underivable. Prefer "
        "KEEPER_MASTER_SECRET, which you can back up and re-import.",
        KMS_KEY_PATH,
    )
    return master, "kms-app-id-bound"


def _master() -> bytes:
    if _master_cache:
        return _master_cache[0]
    master, source = _load_master()
    _assert_continuity(master, source)
    _master_cache.append(master)
    _master_source.append(source)
    log.info(
        "master loaded source=%s fingerprint=%s", source, master_fingerprint(master)
    )
    return master


def _assert_continuity(master: bytes, source: str) -> None:
    """Fail-closed continuity gate (the pinning half).

    `KEEPER_EXPECTED_MASTER_FINGERPRINT` pins the master itself, which is what actually matters — it
    catches an app_id change, a mis-imported secret, and a typo'd env var identically, because all
    three present as the same symptom. `KEEPER_EXPECTED_APP_ID` pins the CVM identity as a second,
    earlier signal.

    Refusing to start is deliberate. A keeper that serves under the WRONG master silently derives
    notes nobody can spend and hands out commitments for deposits that are already lost.
    """
    expected_fp = (os.environ.get("KEEPER_EXPECTED_MASTER_FINGERPRINT") or "").strip().lower()
    if expected_fp:
        actual = master_fingerprint(master)
        if actual != expected_fp:
            raise RuntimeError(
                "MASTER KEY CONTINUITY FAILURE.\n"
                f"  expected fingerprint: {expected_fp}\n"
                f"  loaded fingerprint:   {actual}   (source={source})\n"
                "Every managed note derived under the expected master is UNDERIVABLE with this key. "
                "Do not serve. Restore the correct KEEPER_MASTER_SECRET, or if this change is "
                "intentional, sweep all managed notes under the old master first."
            )

    expected_app = (os.environ.get("KEEPER_EXPECTED_APP_ID") or "").strip()
    if expected_app:
        actual_app = _app_id()
        if actual_app and actual_app != expected_app:
            if source == "kms-app-id-bound":
                raise RuntimeError(
                    f"CVM app_id changed ({expected_app} -> {actual_app}) and the master is "
                    "KMS-derived, so it changed with it. Every managed note is underivable. "
                    "Import the previous master via KEEPER_MASTER_SECRET."
                )
            log.warning(
                "CVM app_id changed (%s -> %s); master is imported so derivation is unaffected.",
                expected_app, actual_app,
            )


def _authorized() -> bool:
    if not AUTH_TOKEN:
        # Deny by default: an empty token must never mean "open", or a misconfigured deploy silently
        # exposes note derivation to anything that can reach the port.
        return not IS_PROD
    supplied = request.headers.get("X-Keeper-Token", "")
    return bool(supplied) and supplied == AUTH_TOKEN


def _public(payload: dict) -> dict:
    leaked = set(payload) - _PUBLIC_ONLY
    if leaked:
        raise RuntimeError(f"keeper response would leak non-public fields: {sorted(leaked)}")
    return payload


def _err(message: str, status: int):
    return jsonify({"error": message}), status


@app.before_request
def _guard():
    if request.path in ("/health", "/attestation"):
        return None
    if not _authorized():
        return _err("unauthorized", 401)
    return None


@app.route("/health", methods=["GET"])
def health():
    try:
        poseidon.self_test()
        ready = True
        detail = "ok"
    except Exception as e:  # noqa: BLE001 — health must report, not raise
        ready = False
        detail = str(e)
    # The master fingerprint is the value ops compares before and after EVERY redeploy. A change
    # means every existing managed note is underivable, and nothing else surfaces that.
    fingerprint, source, app_id = None, None, None
    try:
        master = _master()
        fingerprint = master_fingerprint(master)
        source = _master_source[0] if _master_source else None
        app_id = _app_id()
    except Exception as e:  # noqa: BLE001 — health reports, never raises
        ready = False
        detail = f"master unavailable: {e}"

    attested, attest_detail = _in_tee()
    return jsonify({
        "service": "shielded-keeper",
        "ready": ready,
        "detail": detail,
        "kms_key_path": KMS_KEY_PATH,
        "env": SIPHON_ENV,
        # True custody requires BOTH an attested TEE and a master that is not a dev env key.
        "enclave": attested and source != "dev-env",
        "attested": attested,
        "attestation_detail": None if attested else attest_detail,
        "master_source": source,
        "master_fingerprint": fingerprint,
        "app_id": app_id,
    }), (200 if ready else 503)


@app.route("/attestation", methods=["GET"])
def attestation():
    """DCAP quote binding this keeper's measurement, so an integrator can verify which code holds
    their note material rather than taking our word for it."""
    try:
        from dstack_sdk import DstackClient

        quote = DstackClient().get_quote(b"siphon-shielded-keeper")
        return jsonify({"quote": quote.quote, "event_log": getattr(quote, "event_log", None)})
    except Exception as e:  # noqa: BLE001
        return _err(f"attestation unavailable: {e}", 503)


@app.route("/accounts/derive", methods=["POST"])
def derive_account():
    """Register/resolve a managed account. Returns a fingerprint, never key material."""
    body = request.get_json(silent=True) or {}
    account_ref = str(body.get("account_ref") or "").strip()
    if not account_ref:
        return _err("account_ref is required", 400)

    master = _master()
    fingerprint = derive.account_fingerprint(master, account_ref)

    # Address only — the key stays here. `eth_account` derives it; if unavailable the account is
    # still usable for note derivation, so this degrades rather than failing the call.
    owner_address = None
    try:
        from eth_account import Account

        owner_address = Account.from_key(derive.owner_key(master, account_ref)).address
    except Exception as e:  # noqa: BLE001
        log.warning("owner address unavailable: %s", e)

    return jsonify(_public({
        "account_ref": account_ref,
        "fingerprint": fingerprint,
        "owner_address": owner_address,
    }))


@app.route("/notes/allocate", methods=["POST"])
def allocate_note():
    """Derive one note's PUBLIC values.

    Deterministic and idempotent: the same (account_ref, index, amount, label) always yields the
    same commitment, so a retried deposit cannot mint a second, divergent note.
    """
    body = request.get_json(silent=True) or {}
    account_ref = str(body.get("account_ref") or "").strip()
    if not account_ref:
        return _err("account_ref is required", 400)

    try:
        index = int(body.get("index"))
        amount = int(body.get("amount"))
    except (TypeError, ValueError):
        return _err("index and amount must be integers", 400)
    if amount <= 0:
        return _err("amount must be positive", 400)

    label_raw = body.get("label")
    scope, nonce = body.get("scope"), body.get("nonce")
    if label_raw is not None:
        label = int(label_raw)
    elif scope is not None and nonce is not None:
        label = poseidon.label_hash(int(scope), int(nonce))
    else:
        return _err("provide either label, or scope+nonce to mint one", 400)

    nullifier, secret = derive.note_secrets(_master(), account_ref, index)
    precommitment = poseidon.precommitment_hash(nullifier, secret)
    commitment = poseidon.commitment_hash(amount, label, precommitment)
    nullifier_hash = poseidon.nullifier_hash(nullifier)
    # nullifier and secret go out of scope here and are never serialized.

    return jsonify(_public({
        "account_ref": account_ref,
        "index": index,
        "amount": str(amount),
        "label": str(label),
        "precommitment": str(precommitment),
        "commitment": str(commitment),
        "nullifier_hash": str(nullifier_hash),
    }))


@app.route("/notes/reconstruct", methods=["POST"])
def reconstruct_notes():
    """Re-derive a RANGE of notes from the master key alone.

    This is the disaster-recovery path that random note secrets cannot offer: if the gateway's note
    index is lost entirely, scanning indices here and matching commitments against the on-chain tree
    recovers every managed note.
    """
    body = request.get_json(silent=True) or {}
    account_ref = str(body.get("account_ref") or "").strip()
    if not account_ref:
        return _err("account_ref is required", 400)

    try:
        start = int(body.get("start", 0))
        count = int(body.get("count", 50))
        amount = int(body.get("amount", 0))
        label = int(body.get("label", 0))
    except (TypeError, ValueError):
        return _err("start, count, amount, label must be integers", 400)
    if count < 1 or count > 500:
        return _err("count must be between 1 and 500", 400)

    master = _master()
    out = []
    for i in range(start, start + count):
        nullifier, secret = derive.note_secrets(master, account_ref, i)
        precommitment = poseidon.precommitment_hash(nullifier, secret)
        entry = {
            "index": i,
            "precommitment": str(precommitment),
            "nullifier_hash": str(poseidon.nullifier_hash(nullifier)),
        }
        if amount and label:
            entry["commitment"] = str(poseidon.commitment_hash(amount, label, precommitment))
        out.append(_public(entry))

    return jsonify({"account_ref": account_ref, "notes": out})


if __name__ == "__main__":
    poseidon.self_test()  # refuse to serve on a mismatched hash backend
    app.run(host=os.environ.get("KEEPER_HOST", "127.0.0.1"),
            port=int(os.environ.get("KEEPER_PORT", "5020")))
