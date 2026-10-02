"""Full DCAP verification of a TDX attestation, server-side (Python port of the browser
verifier in siphon-app/src/lib/decryptorAttestation.ts).

Three independent checks, same trust model as the sealed-ClientKey flow:

  1. signature chain — the raw quote is sent to a DCAP verifier (Phala's hosted attestation
     API by default) which validates it against Intel's roots. Fail closed.
  2. identity binding — quote.report_data == sha256(<preimage>), where the preimage ties the
     quote to the exact value we are about to trust (here: the signer's payout address).
  3. measurement pin — the dstack event log replays to the quote's RTMR3, and its
     compose-hash event equals the pinned measurement of the app version we deployed.

Used by polymarket_client before bridging funds to the CVM order-signer. Pure functions —
no Flask/db imports — so they are unit-testable with synthetic quotes.
"""
import hashlib
import json
import os
import struct

import requests

QUOTE_VERIFY_URL = os.environ.get(
    "QUOTE_VERIFY_URL", "https://cloud-api.phala.network/api/v1/attestations/verify"
)

# TDX quote v4 layout: 48-byte header, then the TD report body. Offsets within the body:
# rtmr3 at 472, report_data at 520 (each rtmr is 48 bytes, report_data 64).
_QUOTE_HEADER_LEN = 48
_RTMR3_OFFSET = _QUOTE_HEADER_LEN + 472
_REPORT_DATA_OFFSET = _QUOTE_HEADER_LEN + 520
MIN_QUOTE_LEN = _REPORT_DATA_OFFSET + 64

# dstack runtime events: digest = sha384(event_type_le || ":" || event || ":" || payload).
_DSTACK_RUNTIME_EVENT_TYPE = 0x08000001


class DcapVerificationError(RuntimeError):
    """Any failed check. Callers must treat this as 'do not trust the enclave'."""


def _unhex(value: str) -> bytes:
    return bytes.fromhex(value.removeprefix("0x"))


def verify_quote_signature(quote_hex: str, verify_url: str = None, timeout: int = 30) -> None:
    """Check 1: the quote's ECDSA signature chain, via the hosted DCAP verifier. Fail closed —
    an unreachable verifier or a non-verified verdict both raise."""
    url = verify_url or QUOTE_VERIFY_URL
    try:
        res = requests.post(url, json={"hex": quote_hex}, timeout=timeout)
    except requests.RequestException as e:
        raise DcapVerificationError(f"DCAP verifier unreachable: {e}")
    try:
        body = res.json()
    except ValueError:
        body = {}
    if not res.ok:
        raise DcapVerificationError(
            f"DCAP verifier rejected the quote (HTTP {res.status_code}): "
            f"{json.dumps(body)[:200]}"
        )
    if not (isinstance(body, dict) and (body.get("quote") or {}).get("verified") is True):
        raise DcapVerificationError("quote signature chain NOT verified by the DCAP verifier")


def verify_report_data_binding(quote: bytes, preimage: str) -> None:
    """Check 2: quote.report_data[:32] == sha256(preimage) — binds the quote to the exact
    value we are trusting (e.g. 'siphon-order-signer:<address>')."""
    if len(quote) < MIN_QUOTE_LEN:
        raise DcapVerificationError(f"TDX quote too short ({len(quote)} bytes)")
    expected = hashlib.sha256(preimage.encode()).digest()
    report_data = quote[_REPORT_DATA_OFFSET:_REPORT_DATA_OFFSET + 32]
    if report_data != expected:
        raise DcapVerificationError("quote report_data does not bind the expected identity")


def _event_digest(ev: dict) -> bytes:
    """A dstack runtime event's digest. dstack 0.5.9 returns EMPTY digest fields — verifiers
    recompute them, which directly binds each payload into the RTMR3 chain (a lying log can't
    claim a fake payload). A populated digest must still commit to the payload."""
    computed = hashlib.sha384(
        struct.pack("<I", int(ev.get("event_type", 0)))
        + b":" + str(ev.get("event", "")).encode()
        + b":" + _unhex(str(ev.get("event_payload", "")))
    ).digest()
    claimed_hex = str(ev.get("digest") or "")
    if claimed_hex:
        claimed = _unhex(claimed_hex)
        if int(ev.get("event_type", 0)) == _DSTACK_RUNTIME_EVENT_TYPE and claimed != computed:
            raise DcapVerificationError(
                f'event "{ev.get("event")}" digest does not commit to its payload'
            )
        return claimed
    return computed


def verify_measurement_pin(quote: bytes, event_log_json: str, pinned_measurement: str) -> None:
    """Check 3: replay the event log into RTMR3 and require its compose-hash event to equal
    the pinned measurement (the dstack compose-hash of the exact app version we deployed)."""
    pinned = (pinned_measurement or "").lower().removeprefix("0x")
    if not pinned:
        raise DcapVerificationError("no measurement pinned")
    try:
        events = json.loads(event_log_json)
        assert isinstance(events, list)
    except Exception:
        raise DcapVerificationError("attestation event_log is not a JSON array")

    # Replay RTMR3: mr = sha384(mr48 || digest48) over imr==3 events, from 48 zero bytes.
    mr = b"\x00" * 48
    for ev in events:
        if ev.get("imr") != 3:
            continue
        digest = _event_digest(ev)
        mr = hashlib.sha384(mr + digest.ljust(48, b"\x00")).digest()
    rtmr3 = quote[_RTMR3_OFFSET:_RTMR3_OFFSET + 48]
    if mr != rtmr3:
        raise DcapVerificationError(
            "event log does not replay to the quote's RTMR3 — log is forged or stale"
        )

    compose = next(
        (ev for ev in events if ev.get("imr") == 3 and ev.get("event") == "compose-hash"), None
    )
    if not compose:
        raise DcapVerificationError("no compose-hash event in the attested event log")
    payload = str(compose.get("event_payload", "")).lower().removeprefix("0x")
    if payload != pinned:
        raise DcapVerificationError(
            f"compose-hash {payload[:16]}… != pinned measurement {pinned[:16]}… — "
            "wrong or outdated enclave"
        )


def verify_attestation(
    quote_hex: str,
    report_data_preimage: str,
    event_log_json: str = None,
    pinned_measurement: str = None,
    verify_url: str = None,
) -> None:
    """Full verification, fail closed. Raises DcapVerificationError on ANY mismatch.

    Runs checks 1+2 always; check 3 only when a measurement is pinned (a pin without an
    event log is an error — an attacker could simply omit the log)."""
    if not quote_hex:
        raise DcapVerificationError("no TDX quote in attestation")
    quote = _unhex(quote_hex)
    verify_quote_signature(quote_hex, verify_url=verify_url)
    verify_report_data_binding(quote, report_data_preimage)
    if pinned_measurement:
        if not event_log_json:
            raise DcapVerificationError("measurement pinned but attestation has no event log")
        verify_measurement_pin(quote, event_log_json, pinned_measurement)
