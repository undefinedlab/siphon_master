"""Sentry error tracking for the API gateway.

WHY
GAPS Epic 3's goal is real-time error visibility without SSH-ing into the box. Its tasks only
cover the frontend and the Supabase containers, so an unhandled exception in the gateway — the
sole public door — reached nobody. This closes that for the FastAPI surface.

RELATIONSHIP TO logging_config.py
That module already redacts sensitive field names in log *lines*. This is the same policy applied
to Sentry *events*, which carry far more than a log line: stack-frame locals, request bodies,
headers, and breadcrumbs. The two share the sensitive-name list deliberately — see _SENSITIVE
below, which extends the logging one rather than inventing a second vocabulary.

WHAT MUST NEVER LEAVE
The gateway handles API keys, wallet signatures, proof payloads and note references. Sentry ships
frame locals by default, so an exception raised near a proof or a key would publish it to a
third-party dashboard. Redaction here is a security control, not tidiness.

FAIL-SAFE
No SENTRY_DSN -> inert. Any failure inside before_send drops the event rather than sending an
unredacted one.

Verify with:  python3 -m app.observability_check
"""
from __future__ import annotations

import os
import re
from typing import Any

# Extends logging_config._SENSITIVE with the names that only appear in structured event payloads.
_SENSITIVE_NAMES = (
    "secret", "nullifier", "witness", "client_key", "clientkey", "bounds", "private_key",
    "privatekey", "signature", "api_key", "apikey", "pepper", "salt", "seed", "mnemonic",
    "enc_blob", "encblob", "serverkey", "server_key", "jwt", "token", "password", "dsn",
    "anon_key", "zkp_data", "proof", "authorization", "hmac", "billing_ref", "database_url",
    "db_uri", "redis_url",
)
# Normalise separators before matching: the same secret appears as `api_key` in a JSON body and
# `X-Api-Key` in a header, and a pattern that only knows the underscore form silently passes the
# gateway's primary credential through. Caught by observability_check, which is why it runs.
_SEPARATORS = re.compile(r"[-_\s]")
_NAME_ALTERNATION = re.compile(
    "|".join(_SEPARATORS.sub("", n) for n in _SENSITIVE_NAMES), re.IGNORECASE
)


def _is_secret_key(name: str) -> bool:
    return bool(_NAME_ALTERNATION.search(_SEPARATORS.sub("", name)))


# Kept for callers/tests that expect a pattern object; prefer _is_secret_key.
SECRET_KEY_PATTERN = _NAME_ALTERNATION

# Opaque values long enough to be key material, under any key name.
LONG_OPAQUE = re.compile(r"\b(?:0x)?[A-Fa-f0-9]{40,}\b|\b[A-Za-z0-9+/=_-]{60,}\b")

REDACTED = "[redacted]"
_MAX_DEPTH = 6


def scrub_string(s: str) -> str:
    return LONG_OPAQUE.sub(REDACTED, s)


def scrub(value: Any, depth: int = 0) -> Any:
    if depth > _MAX_DEPTH:
        return "[depth-capped]"
    if isinstance(value, str):
        return scrub_string(value)
    if isinstance(value, (list, tuple)):
        return [scrub(v, depth + 1) for v in value]
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if isinstance(k, str) and _is_secret_key(k):
                out[k] = REDACTED
            else:
                out[k] = scrub(v, depth + 1)
        return out
    return value


def _before_send(event: dict, hint: dict) -> dict | None:
    """Strip credentials and crypto material before the event leaves the process."""
    try:
        for exc in (event.get("exception") or {}).get("values") or []:
            for frame in (exc.get("stacktrace") or {}).get("frames") or []:
                frame.pop("vars", None)
            if isinstance(exc.get("value"), str):
                exc["value"] = scrub_string(exc["value"])

        req = event.get("request")
        if isinstance(req, dict):
            # Request bodies carry proofs, note references and encrypted bounds.
            req.pop("data", None)
            req.pop("cookies", None)
            if isinstance(req.get("headers"), dict):
                # X-Api-Key, Authorization and X-Signature all live here.
                req["headers"] = scrub(req["headers"])
            if isinstance(req.get("url"), str):
                req["url"] = req["url"].split("?")[0]
            req.pop("query_string", None)

        for key in ("extra", "contexts", "tags"):
            if key in event:
                event[key] = scrub(event[key])

        if isinstance(event.get("message"), str):
            event["message"] = scrub_string(event["message"])

        for crumb in (event.get("breadcrumbs") or {}).get("values") or []:
            if isinstance(crumb.get("message"), str):
                crumb["message"] = scrub_string(crumb["message"])
            if isinstance(crumb.get("data"), dict):
                crumb["data"] = scrub(crumb["data"])

        return event
    except Exception:  # noqa: BLE001 — never send a possibly-unredacted event
        return None


def init_sentry(service: str = "api-gateway") -> bool:
    """Initialise Sentry if SENTRY_DSN is set. Returns True if enabled. Never blocks startup."""
    dsn = (os.getenv("SENTRY_DSN") or "").strip()
    if not dsn:
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
    except ImportError:
        print("[observability] SENTRY_DSN set but sentry-sdk is not installed — error tracking OFF")
        return False

    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=(os.getenv("SIPHON_ENV") or "production").strip(),
            release=(os.getenv("GIT_SHA") or "").strip() or None,
            integrations=[
                StarletteIntegration(),
                FastApiIntegration(),
                LoggingIntegration(level=None, event_level="ERROR"),
            ],
            traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.0")),
            # PII off. Integrator API keys and end-user wallets are both identifying, and the
            # gateway's whole billing model is "meter events, never intent".
            send_default_pii=False,
            max_breadcrumbs=30,
            before_send=_before_send,
        )
        sentry_sdk.set_tag("service", service)
        print(f"[observability] Sentry enabled for {service}")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[observability] Sentry init failed ({exc}) — continuing without error tracking")
        return False
