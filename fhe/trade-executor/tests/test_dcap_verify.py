"""Unit tests for dcap_verify — full DCAP verification with synthetic quotes/event logs.

The quote layout constants (report_data at header+520, rtmr3 at header+472) mirror the
browser verifier in siphon-app/src/lib/decryptorAttestation.ts; these tests build synthetic
quotes byte-by-byte so a layout regression in either place shows up as a failure here.
"""
import hashlib
import json
import struct

import pytest

import dcap_verify
from dcap_verify import (
    DcapVerificationError,
    verify_attestation,
    verify_measurement_pin,
    verify_quote_signature,
    verify_report_data_binding,
)

HEADER = 48
RTMR3_OFF = HEADER + 472
REPORT_DATA_OFF = HEADER + 520
QUOTE_LEN = REPORT_DATA_OFF + 64

RUNTIME_EVENT = 0x08000001


def make_quote(report_data_preimage: str = None, rtmr3: bytes = None) -> bytearray:
    quote = bytearray(QUOTE_LEN)
    if report_data_preimage is not None:
        quote[REPORT_DATA_OFF:REPORT_DATA_OFF + 32] = hashlib.sha256(
            report_data_preimage.encode()
        ).digest()
    if rtmr3 is not None:
        quote[RTMR3_OFF:RTMR3_OFF + 48] = rtmr3
    return quote


def runtime_digest(event: str, payload_hex: str) -> bytes:
    return hashlib.sha384(
        struct.pack("<I", RUNTIME_EVENT) + b":" + event.encode() + b":" + bytes.fromhex(payload_hex)
    ).digest()


def replay(events: list) -> bytes:
    mr = b"\x00" * 48
    for ev in events:
        if ev["imr"] != 3:
            continue
        digest = bytes.fromhex(ev["digest"]) if ev.get("digest") else runtime_digest(
            ev["event"], ev["event_payload"]
        )
        mr = hashlib.sha384(mr + digest.ljust(48, b"\x00")).digest()
    return mr


COMPOSE_HASH = "ab" * 48


def make_event_log(compose_payload: str = COMPOSE_HASH, fill_digests: bool = True) -> list:
    events = [
        # non-imr3 event must be ignored by the replay
        {"imr": 1, "event_type": RUNTIME_EVENT, "digest": "", "event": "boot", "event_payload": "00"},
        {"imr": 3, "event_type": RUNTIME_EVENT, "digest": "", "event": "system-preparing", "event_payload": ""},
        {"imr": 3, "event_type": RUNTIME_EVENT, "digest": "", "event": "compose-hash", "event_payload": compose_payload},
        {"imr": 3, "event_type": RUNTIME_EVENT, "digest": "", "event": "instance-id", "event_payload": "deadbeef"},
    ]
    if fill_digests:
        for ev in events:
            ev["digest"] = runtime_digest(ev["event"], ev["event_payload"]).hex()
    return events


# ── report_data binding ─────────────────────────────────────────────────────────────────────

def test_report_data_binding_accepts_matching_preimage():
    quote = make_quote(report_data_preimage="siphon-order-signer:0xAbC")
    verify_report_data_binding(bytes(quote), "siphon-order-signer:0xAbC")


def test_report_data_binding_rejects_other_address():
    quote = make_quote(report_data_preimage="siphon-order-signer:0xAbC")
    with pytest.raises(DcapVerificationError, match="report_data"):
        verify_report_data_binding(bytes(quote), "siphon-order-signer:0xEvil")


def test_report_data_binding_rejects_short_quote():
    with pytest.raises(DcapVerificationError, match="too short"):
        verify_report_data_binding(b"\x00" * 100, "anything")


# ── measurement pin / RTMR3 replay ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("fill_digests", [True, False], ids=["with-digests", "empty-digests"])
def test_measurement_pin_accepts_valid_log(fill_digests):
    events = make_event_log(fill_digests=fill_digests)
    quote = make_quote(rtmr3=replay(events))
    verify_measurement_pin(bytes(quote), json.dumps(events), COMPOSE_HASH)


def test_measurement_pin_accepts_0x_prefixed_pin():
    events = make_event_log()
    quote = make_quote(rtmr3=replay(events))
    verify_measurement_pin(bytes(quote), json.dumps(events), "0x" + COMPOSE_HASH.upper())


def test_measurement_pin_rejects_wrong_compose_hash():
    events = make_event_log(compose_payload="cd" * 48)
    quote = make_quote(rtmr3=replay(events))
    with pytest.raises(DcapVerificationError, match="pinned measurement"):
        verify_measurement_pin(bytes(quote), json.dumps(events), COMPOSE_HASH)


def test_measurement_pin_rejects_log_not_matching_rtmr3():
    events = make_event_log()
    quote = make_quote(rtmr3=b"\x11" * 48)
    with pytest.raises(DcapVerificationError, match="RTMR3"):
        verify_measurement_pin(bytes(quote), json.dumps(events), COMPOSE_HASH)


def test_measurement_pin_rejects_forged_payload_with_stale_digest():
    # Attacker keeps the original digests (so the replay matches RTMR3) but swaps the
    # compose-hash payload. The digest-commits-to-payload check must catch it.
    events = make_event_log(fill_digests=True)
    for ev in events:
        if ev["event"] == "compose-hash":
            ev["event_payload"] = "ee" * 48
    quote = make_quote(rtmr3=b"\x00" * 48)  # rtmr irrelevant; digest check fires first
    with pytest.raises(DcapVerificationError, match="commit"):
        verify_measurement_pin(bytes(quote), json.dumps(events), "ee" * 48)


def test_measurement_pin_rejects_missing_compose_event():
    events = [e for e in make_event_log() if e["event"] != "compose-hash"]
    quote = make_quote(rtmr3=replay(events))
    with pytest.raises(DcapVerificationError, match="compose-hash"):
        verify_measurement_pin(bytes(quote), json.dumps(events), COMPOSE_HASH)


def test_measurement_pin_rejects_garbage_log():
    quote = make_quote()
    with pytest.raises(DcapVerificationError, match="JSON"):
        verify_measurement_pin(bytes(quote), "not json", COMPOSE_HASH)


# ── signature-chain check (verifier API mocked) ─────────────────────────────────────────────

class FakeResponse:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self.ok = status < 400
        self._body = body if body is not None else {}

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def test_quote_signature_accepts_verified(monkeypatch):
    monkeypatch.setattr(
        dcap_verify.requests, "post",
        lambda *a, **k: FakeResponse(200, {"quote": {"verified": True}}),
    )
    verify_quote_signature("00" * 100)


@pytest.mark.parametrize("body", [
    {"quote": {"verified": False}},
    {"quote": {}},
    {},
    {"quote": {"verified": "true"}},  # non-boolean truthiness must not pass
])
def test_quote_signature_rejects_unverified(monkeypatch, body):
    monkeypatch.setattr(dcap_verify.requests, "post", lambda *a, **k: FakeResponse(200, body))
    with pytest.raises(DcapVerificationError, match="NOT verified"):
        verify_quote_signature("00" * 100)


def test_quote_signature_rejects_http_error(monkeypatch):
    monkeypatch.setattr(
        dcap_verify.requests, "post", lambda *a, **k: FakeResponse(500, {"error": "boom"})
    )
    with pytest.raises(DcapVerificationError, match="rejected"):
        verify_quote_signature("00" * 100)


def test_quote_signature_fails_closed_when_unreachable(monkeypatch):
    def _raise(*a, **k):
        raise dcap_verify.requests.ConnectionError("refused")

    monkeypatch.setattr(dcap_verify.requests, "post", _raise)
    with pytest.raises(DcapVerificationError, match="unreachable"):
        verify_quote_signature("00" * 100)


# ── full composition ────────────────────────────────────────────────────────────────────────

def test_verify_attestation_full_pass(monkeypatch):
    monkeypatch.setattr(
        dcap_verify.requests, "post",
        lambda *a, **k: FakeResponse(200, {"quote": {"verified": True}}),
    )
    events = make_event_log()
    quote = make_quote(report_data_preimage="siphon-order-signer:0xAbC", rtmr3=replay(events))
    verify_attestation(
        quote_hex=bytes(quote).hex(),
        report_data_preimage="siphon-order-signer:0xAbC",
        event_log_json=json.dumps(events),
        pinned_measurement=COMPOSE_HASH,
    )


def test_verify_attestation_requires_quote():
    with pytest.raises(DcapVerificationError, match="no TDX quote"):
        verify_attestation(quote_hex="", report_data_preimage="x")


def test_verify_attestation_pin_without_event_log_fails(monkeypatch):
    monkeypatch.setattr(
        dcap_verify.requests, "post",
        lambda *a, **k: FakeResponse(200, {"quote": {"verified": True}}),
    )
    quote = make_quote(report_data_preimage="p")
    with pytest.raises(DcapVerificationError, match="event log"):
        verify_attestation(
            quote_hex=bytes(quote).hex(),
            report_data_preimage="p",
            event_log_json=None,
            pinned_measurement=COMPOSE_HASH,
        )


def test_verify_attestation_skips_pin_check_when_unpinned(monkeypatch):
    monkeypatch.setattr(
        dcap_verify.requests, "post",
        lambda *a, **k: FakeResponse(200, {"quote": {"verified": True}}),
    )
    quote = make_quote(report_data_preimage="p")
    # No pin → signature + binding only; a missing event log is acceptable.
    verify_attestation(quote_hex=bytes(quote).hex(), report_data_preimage="p")
