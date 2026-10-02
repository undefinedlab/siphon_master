"""Webhooks — signed, retried, auditable delivery of operation state transitions.

Businesses cannot poll. This module turns every `operation_service.transition()` into an outbound
event with three properties an integrator's security review will ask about:

* **Signed.** `Siphon-Signature: t=<unix>,v1=<hex hmac>` over `"{t}.{body}"`, HMAC-SHA256 with the
  endpoint's secret. The timestamp is inside the MAC, so a captured payload cannot be replayed later
  against a receiver that enforces a freshness window.
* **Durable.** The delivery row is written BEFORE the HTTP attempt, so a crash mid-flight is retried
  rather than lost, and the integrator can audit exactly what we sent and what came back.
* **Backed off.** Failures retry on exponential backoff up to `webhook_max_attempts`, then park as
  `failed` for inspection — never an infinite hot loop against a broken sink.

SSRF: endpoint URLs are integrator-supplied, so `validate_url` refuses non-HTTP(S) schemes, and in
production refuses plaintext http:// and any host that resolves into private/loopback/link-local
space. Without that check a webhook endpoint is a confused-deputy port scanner of our own VPC.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import logging
import secrets
import socket
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import BadRequest, NotFound
from app.repository.models import Operation, WebhookDelivery, WebhookEndpoint

logger = logging.getLogger("siphon.gateway.webhooks")

SIGNATURE_HEADER = "Siphon-Signature"
_MAX_BODY_LOG = 500


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# URL validation (SSRF)
# ---------------------------------------------------------------------------

def _is_blocked_ip(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError):
        return True  # unresolvable -> refuse rather than accept
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return True
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return True
    return False


def validate_url(url: str) -> str:
    """Reject anything that would make a webhook endpoint an SSRF primitive."""
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https"):
        raise BadRequest("Webhook url must be http or https.")
    if not parsed.hostname:
        raise BadRequest("Webhook url must include a host.")

    settings = get_settings()
    env = (getattr(settings, "siphon_env", None) or "").strip().lower()
    is_prod = env in {"prod", "production"}

    if is_prod and settings.webhook_require_https and parsed.scheme != "https":
        raise BadRequest("Webhook url must use https in production.")
    # Always refuse RFC1918/link-local targets — staging must not become an SSRF scanner even
    # when SIPHON_ENV is accidentally left at dev.
    if _is_blocked_ip(parsed.hostname):
        raise BadRequest("Webhook url resolves to a non-public address.")
    return url


# ---------------------------------------------------------------------------
# Signing
# ---------------------------------------------------------------------------

def sign(secret: str, body: str, timestamp: int | None = None) -> str:
    """Build the `Siphon-Signature` header value for a body."""
    ts = int(timestamp if timestamp is not None else _now().timestamp())
    mac = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    return f"t={ts},v1={mac}"


def verify_signature(secret: str, body: str, header: str, *, tolerance_seconds: int = 300) -> bool:
    """Reference verifier — the exact check we document for integrators.

    Constant-time compare, and the timestamp must be inside the tolerance window so a captured
    delivery cannot be replayed indefinitely.
    """
    try:
        parts = dict(p.split("=", 1) for p in (header or "").split(","))
        ts = int(parts["t"])
        got = parts["v1"]
    except (ValueError, KeyError):
        return False

    if abs(int(_now().timestamp()) - ts) > tolerance_seconds:
        return False

    expected = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, got)


def generate_secret() -> str:
    return "whsec_" + secrets.token_urlsafe(32)


# ---------------------------------------------------------------------------
# Enqueue
# ---------------------------------------------------------------------------

def _subscribed(endpoint: WebhookEndpoint, event_type: str) -> bool:
    events = endpoint.events or ["*"]
    return "*" in events or event_type in events


def enqueue_operation_event(db: Session, op: Operation) -> list[WebhookDelivery]:
    """Fan one operation transition out to every subscribed active endpoint for that key."""
    settings = get_settings()
    if not settings.webhook_enabled:
        return []

    event_type = f"operation.{op.state}"
    endpoints = (
        db.query(WebhookEndpoint)
        .filter(WebhookEndpoint.api_key_id == op.api_key_id, WebhookEndpoint.status == "active")
        .all()
    )

    from app.services import operation_service

    payload = {
        "id": f"evt_{secrets.token_hex(12)}",
        "type": event_type,
        "created_at": _now().isoformat(),
        "data": {"object": _jsonable(operation_service.public_view(op))},
    }

    created: list[WebhookDelivery] = []
    for ep in endpoints:
        if not _subscribed(ep, event_type):
            continue
        row = WebhookDelivery(
            endpoint_id=ep.id,
            api_key_id=op.api_key_id,
            operation_id=op.id,
            event_type=event_type,
            payload=payload,
            status="pending",
            next_attempt_at=_now(),
        )
        db.add(row)
        created.append(row)
    if created:
        db.flush()
    return created


def _jsonable(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        out[k] = v.isoformat() if isinstance(v, datetime) else v
    return out


# ---------------------------------------------------------------------------
# Delivery
# ---------------------------------------------------------------------------

def _backoff_seconds(attempts: int) -> int:
    """1m, 5m, 25m, 2h5m, 10h25m … capped at 24h."""
    return min(60 * (5 ** max(0, attempts - 1)), 86_400)


def deliver_one(db: Session, delivery: WebhookDelivery, *, client: httpx.Client | None = None) -> bool:
    """Attempt one delivery. Returns True on success. Never raises for transport failure."""
    settings = get_settings()
    endpoint = db.query(WebhookEndpoint).filter_by(id=delivery.endpoint_id).first()
    if endpoint is None or endpoint.status != "active":
        delivery.status = "failed"
        delivery.last_error = "endpoint missing or disabled"
        db.flush()
        return False

    body = json.dumps(delivery.payload or {}, sort_keys=True, separators=(",", ":"))
    headers = {
        "Content-Type": "application/json",
        SIGNATURE_HEADER: sign(endpoint.secret, body),
        "Siphon-Event-Type": delivery.event_type,
        "Siphon-Delivery-Id": delivery.id,
    }

    delivery.attempts = int(delivery.attempts or 0) + 1
    owns_client = client is None
    try:
        client = client or httpx.Client(timeout=settings.webhook_timeout_seconds)
        resp = client.post(endpoint.url, content=body, headers=headers)
        delivery.response_status = resp.status_code
        if 200 <= resp.status_code < 300:
            delivery.status = "delivered"
            delivery.delivered_at = _now()
            delivery.last_error = None
            db.flush()
            return True
        delivery.last_error = f"HTTP {resp.status_code}: {resp.text[:_MAX_BODY_LOG]}"
    except Exception as e:  # transport failure, DNS, timeout
        delivery.last_error = f"{type(e).__name__}: {str(e)[:_MAX_BODY_LOG]}"
    finally:
        if owns_client and client is not None:
            client.close()

    if delivery.attempts >= settings.webhook_max_attempts:
        delivery.status = "failed"
        delivery.next_attempt_at = None
        logger.warning(
            "webhook_delivery_exhausted endpoint=%s delivery=%s attempts=%s",
            delivery.endpoint_id, delivery.id, delivery.attempts,
        )
    else:
        delivery.status = "pending"
        delivery.next_attempt_at = _now() + timedelta(seconds=_backoff_seconds(delivery.attempts))
    db.flush()
    return False


def drain_pending(db: Session, *, limit: int = 50, client: httpx.Client | None = None) -> int:
    """Deliver every due pending delivery. Returns the count successfully delivered."""
    due = (
        db.query(WebhookDelivery)
        .filter(
            WebhookDelivery.status == "pending",
            (WebhookDelivery.next_attempt_at.is_(None)) | (WebhookDelivery.next_attempt_at <= _now()),
        )
        .order_by(WebhookDelivery.created_at)
        .limit(limit)
        .all()
    )
    delivered = 0
    for d in due:
        if deliver_one(db, d, client=client):
            delivered += 1
    return delivered


def get_owned(db: Session, endpoint_id: str, api_key_id: str) -> WebhookEndpoint:
    ep = db.query(WebhookEndpoint).filter_by(id=endpoint_id).first()
    if ep is None or ep.api_key_id != api_key_id:
        raise NotFound("Webhook endpoint not found.")
    return ep
