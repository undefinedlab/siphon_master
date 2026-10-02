"""Receipt notary — canonical digest + enclave signature for compliant receipts.

The digest binds the three receipt layers into one commitment:

    digest = sha256( canonical( public_fields ) ‖ identity_hash ‖ shielded_ref_hash )

Signing happens in the DCAP-attested order-signer (the same TEE that custodies the executor
keys), so a verifier can confirm a receipt is genuine — and that it was minted by the real
enclave — without trusting the Siphon server. When the order-signer isn't configured (local
dev), a plaintext dev key signs instead; such receipts carry attestation_ref='dev' and MUST
NOT be treated as attested.
"""
from __future__ import annotations  # executor runs Python 3.9 — defer `X | None` annotations

import os
import json
import hashlib

import requests

ORDER_SIGNER_URL = os.environ.get("ORDER_SIGNER_URL", "").rstrip("/")
ORDER_SIGNER_TOKEN = os.environ.get("ORDER_SIGNER_TOKEN", "")
# Local-dev only fallback. Never set in the CVM; produces attestation_ref='dev'.
RECEIPT_SIGNER_DEV_KEY = os.environ.get("RECEIPT_SIGNER_DEV_KEY", "")

# Fields that are safe to disclose and therefore committed in the clear inside the digest.
_PUBLIC_FIELDS = ("kind", "tx_hash", "chain_id", "token", "amount", "counterparty", "occurred_at")


def _sha256_hex(data: bytes) -> str:
    return "0x" + hashlib.sha256(data).hexdigest()


def _canonical_json(obj) -> str:
    """Deterministic JSON: sorted keys, no spaces, raw UTF-8. `ensure_ascii=False` is required so
    the browser verifier (JSON.stringify leaves unicode as-is) produces a byte-identical string —
    otherwise names/addresses with non-ASCII characters would hash differently across languages."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def identity_hash(identity: dict | None) -> str:
    """Hash of the identity layer — the digest commits to identity WITHOUT exposing it, so a
    verifier can confirm the identity block wasn't altered once the owner chooses to reveal it."""
    return _sha256_hex(_canonical_json(identity or {}).encode("utf-8"))


def digest_from_idhash(public: dict, id_hash: str, shielded_ref_hash: str | None) -> str:
    """Receipt digest from the PUBLIC fields + an already-computed identity_hash. This is what a
    verifier uses: it never sees the raw identity, only the commitment, so it recomputes the digest
    from `identity_hash` directly (recomputing it from an absent/empty identity would mismatch)."""
    body = {k: public.get(k) for k in _PUBLIC_FIELDS}
    body["identity_hash"] = id_hash
    body["shielded_ref_hash"] = shielded_ref_hash or ""
    return _sha256_hex(_canonical_json(body).encode("utf-8"))


def canonical_digest(public: dict, identity: dict | None, shielded_ref_hash: str | None) -> str:
    """Deterministic receipt digest (minting side — has the raw identity). Same inputs → same
    digest on any machine, so the signature is reproducible and independently verifiable."""
    return digest_from_idhash(public, identity_hash(identity), shielded_ref_hash)


def is_tee_signer() -> bool:
    return bool(ORDER_SIGNER_URL and ORDER_SIGNER_TOKEN)


def sign_receipt(digest: str) -> dict:
    """Sign a receipt digest. Returns {signature, address, attestation_ref}.

    RECEIPT_SIGNER_DEV_KEY is an explicit dev override (attestation_ref='dev') — useful in the
    rollout window before the order-signer CVM ships /receipt/sign. Remove it to switch to real
    enclave attestation. Otherwise the TEE signs (EIP-191) and returns its attestation reference."""
    if RECEIPT_SIGNER_DEV_KEY:
        from eth_account import Account
        from eth_account.messages import encode_defunct

        acct = Account.from_key(RECEIPT_SIGNER_DEV_KEY)
        signed = acct.sign_message(encode_defunct(hexstr=digest))
        sig = signed.signature.hex()
        return {
            "signature": sig if sig.startswith("0x") else "0x" + sig,
            "address": acct.address,
            "attestation_ref": "dev",
        }

    if is_tee_signer():
        res = requests.post(
            f"{ORDER_SIGNER_URL}/receipt/sign",
            headers={"X-API-TOKEN": ORDER_SIGNER_TOKEN},
            json={"digest": digest},
            timeout=20,
        )
        if res.status_code != 200:
            raise RuntimeError(
                f"order-signer /receipt/sign failed (HTTP {res.status_code}): {res.text[:300]}"
            )
        data = res.json()
        return {
            "signature": data["signature"],
            "address": data["address"],
            "attestation_ref": data.get("attestation_ref"),
        }

    raise RuntimeError(
        "No receipt signer configured: set ORDER_SIGNER_URL+TOKEN (TEE) or "
        "RECEIPT_SIGNER_DEV_KEY (local dev only)."
    )
