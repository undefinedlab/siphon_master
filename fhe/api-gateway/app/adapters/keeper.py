"""Client for the shielded keeper (the enclave that custodies managed-account note material).

The keeper is a fixed internal host, never user-supplied, so this is not an SSRF surface. Two rules
this client enforces on the gateway side:

* **Never persist or log a keeper response wholesale.** The keeper is designed to return only public
  values, but the gateway must not become the place where that guarantee is first assumed —
  `_assert_no_secrets` fails loudly if spendable material ever appears in a response, rather than
  writing it to the database.
* **Fail closed.** A keeper outage must never fall back to gateway-side derivation. There is no
  local fallback path by design: deriving notes outside the enclave would defeat the custody model
  entirely, so an unreachable keeper is a 503, full stop.
"""
from __future__ import annotations

import logging

import httpx

from app.config import get_settings
from app.errors import DownstreamUnavailable

logger = logging.getLogger("siphon.gateway.keeper")

_FORBIDDEN_KEYS = {"nullifier", "secret", "master", "seed", "private_key"}


def _assert_no_secrets(payload) -> None:
    """Tripwire: spendable material must never cross into gateway memory."""
    if isinstance(payload, dict):
        for k, v in payload.items():
            if k.lower() in _FORBIDDEN_KEYS:
                raise RuntimeError(
                    f"keeper returned forbidden field '{k}' — refusing to handle secret material"
                )
            _assert_no_secrets(v)
    elif isinstance(payload, list):
        for item in payload:
            _assert_no_secrets(item)


class KeeperClient:
    def __init__(self, base_url: str | None = None, token: str | None = None, timeout: float | None = None):
        s = get_settings()
        self.base_url = (base_url or s.keeper_url).rstrip("/")
        self.token = token if token is not None else s.keeper_api_token
        self.timeout = timeout or s.keeper_timeout_seconds

    def _post(self, path: str, body: dict) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["X-Keeper-Token"] = self.token
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.post(f"{self.base_url}{path}", json=body, headers=headers)
        except Exception as e:
            raise DownstreamUnavailable(f"Shielded keeper unreachable: {type(e).__name__}")

        if resp.status_code >= 400:
            # Never echo the keeper's body to the caller — it is an internal service.
            logger.warning("keeper %s -> %s", path, resp.status_code)
            raise DownstreamUnavailable(f"Shielded keeper rejected the request ({resp.status_code}).")

        data = resp.json()
        _assert_no_secrets(data)
        return data

    def health(self) -> dict:
        try:
            with httpx.Client(timeout=self.timeout) as client:
                return client.get(f"{self.base_url}/health").json()
        except Exception as e:
            raise DownstreamUnavailable(f"Shielded keeper unreachable: {type(e).__name__}")

    def attestation(self) -> dict:
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.get(f"{self.base_url}/attestation")
                if resp.status_code >= 400:
                    raise DownstreamUnavailable("Keeper attestation unavailable.")
                return resp.json()
        except DownstreamUnavailable:
            raise
        except Exception as e:
            raise DownstreamUnavailable(f"Shielded keeper unreachable: {type(e).__name__}")

    def derive_account(self, keeper_ref: str) -> dict:
        return self._post("/accounts/derive", {"account_ref": keeper_ref})

    def allocate_note(
        self,
        *,
        keeper_ref: str,
        index: int,
        amount: int,
        label: str | None = None,
        scope: int | None = None,
        nonce: int | None = None,
    ) -> dict:
        body: dict = {"account_ref": keeper_ref, "index": index, "amount": amount}
        if label is not None:
            body["label"] = str(label)
        else:
            body["scope"] = scope
            body["nonce"] = nonce
        return self._post("/notes/allocate", body)

    def reconstruct(self, *, keeper_ref: str, start: int, count: int,
                    amount: int = 0, label: str | int = 0) -> dict:
        return self._post("/notes/reconstruct", {
            "account_ref": keeper_ref, "start": start, "count": count,
            "amount": amount, "label": str(label),
        })


def get_keeper_client() -> KeeperClient:
    return KeeperClient()
