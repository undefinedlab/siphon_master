"""Compliance receipts — signed, exportable evidence of what was screened.

This is the artifact that converts "we're the compliant one" from a slogan into something a
compliance officer can file. It proves an address was screened, against which list version, under
which ASP root and enclave measurement, at what time — and it does so WITHOUT revealing the amount,
the counterparty, or any note material. Privacy and provability at once is the whole product claim.

Design constraints that matter:

* **Canonical serialization.** The signature covers `json.dumps(payload, sort_keys=True,
  separators=(",", ":"))`. Verification years later must reproduce the exact bytes, so key order and
  whitespace cannot be incidental.
* **Key id in the receipt.** `key_id` travels inside the signed payload, so rotating the signing key
  (or moving HMAC -> Ed25519) leaves every historical receipt verifiable against the key that
  actually produced it.
* **No amounts.** `subject_address`, decision, and provenance only. A receipt that leaked amounts
  would defeat the product it is evidence for.
* **Receipts are minted for denials too.** A refused operation is exactly the case an auditor most
  wants evidence of.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import NotFound
from app.repository.models import ComplianceReceipt

RECEIPT_SCHEMA = "siphon.compliance.receipt.v1"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def canonical(payload: dict) -> str:
    """The exact bytes a signature covers. Must be stable across versions and languages."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def _sign(payload: dict, secret: str) -> str:
    return hmac.new(secret.encode(), canonical(payload).encode(), hashlib.sha256).hexdigest()


def build_payload(
    *,
    receipt_id: str,
    api_key_id: str,
    operation_id: str | None,
    subject_address: str,
    chain_id: int | None,
    result: str,
    list_version: str | None,
    asp_root: str | None,
    attestation_digest: str | None,
    policy_version: int | None,
    screened_at: datetime,
) -> dict:
    """The signed body. Deliberately excludes amount, recipient, and note material."""
    return {
        "schema": RECEIPT_SCHEMA,
        "receipt_id": receipt_id,
        "api_key_id": api_key_id,
        "operation_id": operation_id,
        "subject_address": (subject_address or "").lower(),
        "chain_id": chain_id,
        "result": result,
        "list_version": list_version,
        "asp_root": asp_root,
        "attestation_digest": attestation_digest,
        "policy_version": policy_version,
        "screened_at": screened_at.isoformat(),
        "key_id": get_settings().receipt_signing_key_id,
    }


def mint(
    db: Session,
    *,
    api_key_id: str,
    subject_address: str,
    result: str,
    operation_id: str | None = None,
    chain_id: int | None = None,
    list_version: str | None = None,
    asp_root: str | None = None,
    attestation_digest: str | None = None,
    policy_version: int | None = None,
) -> ComplianceReceipt:
    settings = get_settings()
    row = ComplianceReceipt(
        api_key_id=api_key_id,
        operation_id=operation_id,
        subject_address=(subject_address or "").lower(),
        chain_id=chain_id,
        result=result,
        list_version=list_version,
        asp_root=asp_root,
        attestation_digest=attestation_digest,
        policy_version=policy_version,
        screened_at=_now(),
        signature="",
        key_id=settings.receipt_signing_key_id,
    )
    db.add(row)
    db.flush()  # assigns row.id, which is inside the signed payload

    payload = build_payload(
        receipt_id=row.id,
        api_key_id=api_key_id,
        operation_id=operation_id,
        subject_address=subject_address,
        chain_id=chain_id,
        result=result,
        list_version=list_version,
        asp_root=asp_root,
        attestation_digest=attestation_digest,
        policy_version=policy_version,
        screened_at=row.screened_at,
    )
    row.payload = payload
    row.signature = _sign(payload, settings.receipt_signing_key)
    db.flush()
    return row


def verify(receipt: ComplianceReceipt | dict, *, secret: str | None = None) -> bool:
    """Verify a receipt, from the DB row or from an exported JSON document."""
    settings = get_settings()
    secret = secret or settings.receipt_signing_key

    if isinstance(receipt, dict):
        payload = receipt.get("payload")
        signature = receipt.get("signature")
    else:
        payload = receipt.payload
        signature = receipt.signature

    if not payload or not signature:
        return False
    return hmac.compare_digest(_sign(payload, secret), signature)


def get_owned(db: Session, receipt_id: str, api_key_id: str) -> ComplianceReceipt:
    row = db.query(ComplianceReceipt).filter_by(id=receipt_id).first()
    if row is None or row.api_key_id != api_key_id:
        raise NotFound("Compliance receipt not found.")
    return row


def for_operation(db: Session, operation_id: str, api_key_id: str) -> list[ComplianceReceipt]:
    return (
        db.query(ComplianceReceipt)
        .filter(
            ComplianceReceipt.operation_id == operation_id,
            ComplianceReceipt.api_key_id == api_key_id,
        )
        .order_by(ComplianceReceipt.created_at)
        .all()
    )


def export_view(row: ComplianceReceipt) -> dict:
    """The self-contained document an integrator hands to an auditor.

    Carries the payload, the signature, and the instructions to verify it — everything needed to
    check the receipt offline without calling this API.
    """
    return {
        "payload": row.payload,
        "signature": row.signature,
        "algorithm": "HMAC-SHA256",
        "key_id": row.key_id,
        "canonicalization": 'json.dumps(payload, sort_keys=True, separators=(",", ":"))',
        "verify": (
            "hmac_sha256(secret, canonical(payload)).hexdigest() == signature; "
            "request the verification secret for key_id from Siphon out-of-band"
        ),
    }
