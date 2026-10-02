"""Deterministic shielded-note derivation.

The protocol's note scheme (siphon-app/src/lib/zkHandler.ts, sdk-ts/src/crypto.ts):

    precommitment = Poseidon(nullifier, secret)
    commitment    = Poseidon(amount, precommitment)
    nullifierHash = Poseidon(nullifier)

Today `nullifier` and `secret` are `crypto.randomBytes` — unrecoverable if the note record is lost,
which is the note-stranding failure this codebase has already hit in production. Here they are
derived instead:

    account_seed = HKDF-SHA256(master, salt="siphon/managed/v1", info=account_ref)
    nullifier    = H(account_seed, "nullifier", index) mod p
    secret       = H(account_seed, "secret",    index) mod p

Consequences, in order of importance:

1. **Notes are recoverable.** Master key + account_ref + index reconstructs the exact note. A lost
   database is an availability problem, not a loss of funds.
2. **The gateway never holds secrets.** Only this process sees `nullifier`/`secret`; callers get
   `precommitment`, `commitment`, `nullifier_hash`.
3. **Domain separation.** Distinct info/label strings per account and per field mean two accounts,
   or the nullifier and secret of one note, can never collide.

The master key comes from dstack KMS *inside* the enclave and is never persisted — same derivation
discipline as order-signer.py, whose KMS_KEY_PATH is likewise fixed because changing it changes
every derived value.
"""
from __future__ import annotations

import hashlib
import hmac

# BN254 scalar field — must match FIELD_SIZE in sdk-ts/src/crypto.ts and the circuits.
FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617

HKDF_SALT = b"siphon/managed/v1"
_NULLIFIER_LABEL = b"nullifier"
_SECRET_LABEL = b"secret"


def _hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    return hmac.new(salt, ikm, hashlib.sha256).digest()


def _hkdf_expand(prk: bytes, info: bytes, length: int = 32) -> bytes:
    out, t, counter = b"", b"", 1
    while len(out) < length:
        t = hmac.new(prk, t + info + bytes([counter]), hashlib.sha256).digest()
        out += t
        counter += 1
    return out[:length]


def account_seed(master: bytes, account_ref: str) -> bytes:
    """Per-account seed. Distinct accounts are cryptographically independent."""
    prk = _hkdf_extract(HKDF_SALT, master)
    return _hkdf_expand(prk, account_ref.encode("utf-8"))


def _field_from(seed: bytes, label: bytes, index: int) -> int:
    """Derive one field element.

    Rejection-samples rather than reducing a single hash mod p: a plain `H(...) % p` is very slightly
    biased toward small values, and these are secrets protecting funds. The loop terminates with
    overwhelming probability on the first iteration (p is within 2^-127 of 2^254).
    """
    counter = 0
    while True:
        digest = hashlib.sha256(
            seed + b"|" + label + b"|" + str(index).encode() + b"|" + str(counter).encode()
        ).digest()
        # Clear the top 2 bits so the value is < 2^254, which bounds rejection to a negligible rate.
        value = int.from_bytes(digest, "big") >> 2
        if 0 < value < FIELD_SIZE:
            return value
        counter += 1


def note_secrets(master: bytes, account_ref: str, index: int) -> tuple[int, int]:
    """(nullifier, secret) for one note. Deterministic: same inputs -> same note, forever."""
    if index < 0:
        raise ValueError("note index must be non-negative")
    seed = account_seed(master, account_ref)
    return (
        _field_from(seed, _NULLIFIER_LABEL, index),
        _field_from(seed, _SECRET_LABEL, index),
    )


def owner_key(master: bytes, account_ref: str) -> bytes:
    """The per-account EVM private key, derived from the same seed as the note material.

    A managed account needs an on-chain identity for two reasons, both of which decide who can move
    funds:

    * `DepositInfo.depositor` — whoever that address is holds ragequit authority over the note. If
      every managed account shared the integrator's treasury address, the integrator could
      unilaterally exit any customer's position, which is a custody claim most platforms neither
      want nor are licensed to make. Per-account derivation keeps that authority isolated.
    * a withdrawal destination that exists before any transaction is signed.

    Derived under a distinct info label, so it is cryptographically independent of the note
    nullifiers and secrets for the same account.
    """
    prk = _hkdf_extract(HKDF_SALT, master)
    return _hkdf_expand(prk, b"owner-key|" + account_ref.encode("utf-8"))


def account_fingerprint(master: bytes, account_ref: str) -> str:
    """A public, non-reversible identifier for an account's key material.

    Lets an integrator (and an auditor) confirm that two deposits belong to the same managed account,
    and that a keeper redeploy still derives the same account, without exposing the seed.
    """
    seed = account_seed(master, account_ref)
    return hashlib.sha256(b"fingerprint|" + seed).hexdigest()[:32]
