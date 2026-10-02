"""Structured JSON logging + request-id middleware + sensitive-field redaction.

Every log line is JSON with a request_id. A global filter redacts known-sensitive field names
(secret, nullifier, witness, client_key, bounds, private_key, signature, api_key) wherever they
appear in a message, so a stray log of a request body can't leak crypto material.
"""
import json
import logging
import re
import uuid
from contextvars import ContextVar

from fastapi import Request

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)

# Field names whose values must never reach the logs. Matches key=value and "key": "value".
_SENSITIVE = ("secret", "nullifier", "witness", "client_key", "clientkey", "bounds",
              "private_key", "privatekey", "signature", "api_key", "apikey", "pepper")
_REDACT_RE = re.compile(
    r'(?i)("?(?:' + "|".join(_SENSITIVE) + r')"?\s*[:=]\s*)("?)([^\s",}]+)(\2)'
)


def _redact(text: str) -> str:
    return _REDACT_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}***REDACTED***{m.group(4)}", text)


class RedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = _redact(record.msg)
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": _request_id.get(),
        }
        return _redact(json.dumps(payload))


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactionFilter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)


def install_request_id_middleware(app) -> None:
    @app.middleware("http")
    async def _request_id_mw(request: Request, call_next):
        rid = request.headers.get("X-Request-ID") or f"req_{uuid.uuid4().hex[:16]}"
        request.state.request_id = rid
        token = _request_id.set(rid)
        try:
            response = await call_next(request)
        finally:
            _request_id.reset(token)
        response.headers["X-Request-ID"] = rid
        return response
