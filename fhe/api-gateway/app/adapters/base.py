"""Shared adapter machinery — explicit timeouts, transient-only retries, error mapping.

Downstream hosts are a fixed internal allowlist (SSRF-safe; no user-supplied URLs). Every call has a
bounded timeout (never infinite). Transient failures (timeout / connect / 5xx) on idempotent GETs are
retried with backoff+jitter; everything that ultimately fails maps to DownstreamUnavailable (503).
The executor's 4xx are forwarded as-is to the caller (which maps them to gateway errors). Circuit
breakers are [DEFERRED v1.1] — not added here.
"""
import random
import time

import httpx

from app.errors import DownstreamUnavailable

_CONNECT_TIMEOUT = 2.0
_READ_TIMEOUT = 10.0
_OVERALL_TIMEOUT = 12.0
_MAX_GET_RETRIES = 2  # total attempts = retries + 1


class DownstreamClient:
    def __init__(self, base_url: str, *, api_token: str | None = None, transport: httpx.BaseTransport | None = None):
        self._base = base_url.rstrip("/")
        self._api_token = api_token
        timeout = httpx.Timeout(_OVERALL_TIMEOUT, connect=_CONNECT_TIMEOUT, read=_READ_TIMEOUT)
        self._http = httpx.Client(base_url=self._base, timeout=timeout, transport=transport)

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict | None = None,
        params: dict | None = None,
        headers: dict[str, str] | None = None,
        internal: bool = False,
        timeout: float | None = None,
    ) -> dict:
        """Make a request; return parsed JSON or raise a mapped gateway error.

        `internal=True` attaches the executor X-API-TOKEN (for internal proxy routes only — NEVER on
        the executor's write-challenge-gated user routes, which reject the token).
        """
        h = dict(headers or {})
        if internal and self._api_token:
            h["X-API-TOKEN"] = self._api_token

        retriable = method.upper() == "GET"
        attempts = (_MAX_GET_RETRIES + 1) if retriable else 1
        last_exc: Exception | None = None

        for attempt in range(attempts):
            try:
                resp = self._http.request(
                    method, path, json=json, params=params, headers=h,
                    **({"timeout": httpx.Timeout(timeout, connect=_CONNECT_TIMEOUT)} if timeout else {}),
                )
            except (httpx.TimeoutException, httpx.ConnectError, httpx.TransportError) as e:
                last_exc = e
            else:
                if resp.status_code >= 500:
                    last_exc = DownstreamUnavailable(f"Downstream {resp.status_code}.")
                elif resp.status_code >= 400:
                    # Client error from the downstream — surface its message, don't retry.
                    raise self._as_client_error(resp)
                else:
                    return resp.json() if resp.content else {}
            # backoff before a retry (transient path only)
            if attempt < attempts - 1:
                time.sleep(min(0.1 * (2 ** attempt) + random.uniform(0, 0.05), 1.0))

        raise DownstreamUnavailable("Downstream service unavailable.") from last_exc

    def _as_client_error(self, resp: httpx.Response) -> Exception:
        """Map a downstream 4xx to a gateway error without leaking internals.

        Overridable per adapter; the base surfaces a generic BadRequest with the downstream's own
        error text when it is a safe string.
        """
        from app.errors import BadRequest, Forbidden, NotFound, Unauthorized, Conflict, IdempotencyKeyReuse

        try:
            msg = (resp.json() or {}).get("error")
        except Exception:
            msg = None
        detail = msg if isinstance(msg, str) else "Downstream rejected the request."
        return {
            400: BadRequest,
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            409: Conflict,
            422: IdempotencyKeyReuse,
        }.get(resp.status_code, BadRequest)(detail)

