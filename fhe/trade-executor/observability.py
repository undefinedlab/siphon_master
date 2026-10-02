"""
Sentry error tracking for the trade-executor.

WHY THIS EXISTS
GAPS Epic 3's goal is "catch errors in real time so the team can debug without SSH-ing into the
EC2". Its three tasks only cover the frontend and the Supabase containers, so a Python exception
that fails a strategy — in scheduler.py, fhe_client.py, decryptor_client.py — reached nobody. It
sat in this box's docker logs until somebody thought to look. This module closes that.

WHY REDACTION IS NOT OPTIONAL HERE
This process handles material that is worth money if it leaks:

  - note secrets sealed for strategies (nullifier / secret pairs)
  - zkp_data: stored withdrawal proof witnesses
  - server keys, client keys, DB URIs, HMAC secrets

Sentry's default behaviour ships local variables from every stack frame. An exception raised
anywhere near a note would therefore put a spendable (nullifier, secret) pair into a third-party
dashboard. A leaked pair is user funds — and the protocol is non-custodial, so nobody can undo it.

The rules below mirror siphon-app/sentry.client.config.ts deliberately, so the frontend and the
backend redact the same shapes. If you change one, change the other.

FAIL-SAFE POSTURE
No DSN configured -> this module does nothing at all. It never blocks startup, and any failure
inside before_send drops the event rather than risking sending an unredacted one.

Verify with:  python3 observability_check.py
"""
from __future__ import annotations

import os
import re
from typing import Any

# Keys whose VALUE is dropped regardless of content. Mirrors SECRET_KEY_PATTERN in
# sentry.client.config.ts, plus the server-only names that have no frontend equivalent.
SECRET_KEY_PATTERN = re.compile(
    r"(nullifier|secret|salt|privkey|private_?key|mnemonic|seed|enc_?blob|clientkey|serverkey"
    r"|jwt|token|password|passwd|dsn|anon_?key|zkp_?data|witness|proof|api_?key|authorization"
    r"|hmac|database_?uri|db_?uri|note_?db|signature)",
    re.IGNORECASE,
)

# Values that are opaque and long enough to be key material, under ANY key name.
# 40+ hex covers addresses/commitments/hashes; 60+ base64ish covers blobs and tokens.
LONG_OPAQUE = re.compile(r"\b(?:0x)?[A-Fa-f0-9]{40,}\b|\b[A-Za-z0-9+/=_-]{60,}\b")

REDACTED = "[redacted]"
_MAX_DEPTH = 6


def scrub_string(s: str) -> str:
    return LONG_OPAQUE.sub(REDACTED, s)


def scrub(value: Any, depth: int = 0) -> Any:
    """Recursively redact secret-shaped keys and long opaque values.

    Depth-capped so a cyclic or pathologically nested structure cannot hang the reporter.
    """
    if depth > _MAX_DEPTH:
        return "[depth-capped]"
    if isinstance(value, str):
        return scrub_string(value)
    if isinstance(value, (list, tuple)):
        return [scrub(v, depth + 1) for v in value]
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if isinstance(k, str) and SECRET_KEY_PATTERN.search(k):
                out[k] = REDACTED
            else:
                out[k] = scrub(v, depth + 1)
        return out
    return value


def _before_send(event: dict, hint: dict) -> dict | None:
    """Strip anything spendable before the event leaves this process.

    Wrapped so that a bug in redaction drops the event instead of sending it raw — the failure
    mode of "no error report" is recoverable; "a nullifier in someone's dashboard" is not.
    """
    try:
        # Stack-frame locals are the main leak path: a frame inside note handling holds the
        # note itself. Sentry includes these by default.
        for exc in (event.get("exception") or {}).get("values") or []:
            for frame in (exc.get("stacktrace") or {}).get("frames") or []:
                frame.pop("vars", None)

        req = event.get("request")
        if isinstance(req, dict):
            # Request bodies on /createStrategy carry encrypted bounds and the input note.
            req.pop("data", None)
            req.pop("cookies", None)
            if isinstance(req.get("headers"), dict):
                req["headers"] = scrub(req["headers"])
            if isinstance(req.get("query_string"), str):
                req["query_string"] = scrub_string(req["query_string"])
            if isinstance(req.get("url"), str):
                req["url"] = req["url"].split("?")[0]

        for key in ("extra", "contexts", "tags"):
            if key in event:
                event[key] = scrub(event[key])

        if isinstance(event.get("message"), str):
            event["message"] = scrub_string(event["message"])

        for exc in (event.get("exception") or {}).get("values") or []:
            if isinstance(exc.get("value"), str):
                exc["value"] = scrub_string(exc["value"])

        for crumb in (event.get("breadcrumbs") or {}).get("values") or []:
            if isinstance(crumb.get("message"), str):
                crumb["message"] = scrub_string(crumb["message"])
            if isinstance(crumb.get("data"), dict):
                crumb["data"] = scrub(crumb["data"])

        return event
    except Exception:  # noqa: BLE001 — never let redaction failure send a raw event
        return None


def init_sentry(service: str = "trade-executor") -> bool:
    """Initialise Sentry if SENTRY_DSN is set. Returns True if enabled.

    Safe to call unconditionally: no DSN, missing package, or init failure all degrade to
    "disabled" rather than blocking the service from starting.
    """
    dsn = (os.getenv("SENTRY_DSN") or "").strip()
    if not dsn:
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.flask import FlaskIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration
    except ImportError:
        # Not installed: the service must still run. Say so once, loudly enough to notice.
        print("[observability] SENTRY_DSN set but sentry-sdk is not installed — error tracking OFF")
        return False

    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=(os.getenv("SIPHON_ENV") or "production").strip(),
            release=(os.getenv("GIT_SHA") or "").strip() or None,
            integrations=[
                FlaskIntegration(),
                # WARNING level and above become events; INFO becomes breadcrumbs.
                LoggingIntegration(level=None, event_level="ERROR"),
            ],
            traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.0")),
            # PII off: wallet addresses are pseudonymous but still user-identifying, and
            # linking them to strategy activity in a third-party dashboard is exactly the
            # correlation this protocol exists to prevent.
            send_default_pii=False,
            max_breadcrumbs=30,
            before_send=_before_send,
        )
        sentry_sdk.set_tag("service", service)
        print(f"[observability] Sentry enabled for {service}")
        return True
    except Exception as exc:  # noqa: BLE001 — never block startup on the reporter
        print(f"[observability] Sentry init failed ({exc}) — continuing without error tracking")
        return False


def capture_strategy_failure(strategy_id: Any, stage: str, exc: BaseException) -> None:
    """Report a strategy failure with safe context.

    Deliberately narrow: strategy id and stage name only. Never the bounds, the note, or the
    proof — the whole point of the FHE layer is that this process cannot see intent, and an
    error reporter must not become the side channel that undoes it.
    """
    try:
        import sentry_sdk
    except ImportError:
        return
    with sentry_sdk.push_scope() as scope:
        scope.set_tag("stage", stage)
        scope.set_context("strategy", {"id": str(strategy_id), "stage": stage})
        sentry_sdk.capture_exception(exc)
