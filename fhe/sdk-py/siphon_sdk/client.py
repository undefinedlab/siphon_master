import time
import uuid
import random
import requests
from eth_account import Account
from eth_account.messages import encode_defunct
from typing import Any, Dict, Generator, Callable, Optional, Union

from siphon_sdk.crypto import generate_note, generate_fhe_key_pair, encrypt_value_fhe
from siphon_sdk.errors import map_error_code_to_exception


class SiphonClient:
    def __init__(self, base_url: str, api_key: str, private_key: Optional[str] = None, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.private_key = private_key
        self.default_timeout = timeout

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
        chain_id: Optional[Union[int, str]] = None,
        timeout: Optional[float] = None
    ) -> Any:
        url = f"{self.base_url}{path}"
        req_timeout = timeout if timeout is not None else self.default_timeout

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/problem+json, application/json",
        }

        # Idempotency key auto-attachment
        is_write = method.upper() in ("POST", "PUT", "PATCH", "DELETE")
        if is_write:
            idem = idempotency_key or str(uuid.uuid4())
            headers["Idempotency-Key"] = idem

        # Wallet Authentication headers
        if self.private_key and chain_id is not None:
            wallet_address = Account.from_key(self.private_key).address
            timestamp = str(int(time.time()))
            message_str = f"Siphon API v1:{chain_id}:{timestamp}"
            msg = encode_defunct(text=message_str)
            sig = Account.sign_message(msg, private_key=self.private_key).signature.hex()

            headers["X-Wallet-Address"] = wallet_address
            headers["X-Signature"] = sig
            headers["X-Timestamp"] = timestamp

        max_attempts = 5
        attempt = 0
        base_delay = 0.5

        while attempt < max_attempts:
            attempt += 1
            try:
                response = requests.request(
                    method=method,
                    url=url,
                    headers=headers,
                    json=body,
                    params=params,
                    timeout=req_timeout
                )

                if 200 <= response.status_code < 300:
                    try:
                        return response.json()
                    except ValueError:
                        return response.text

                # Check if retryable
                is_retryable = response.status_code in (429, 503)
                if is_retryable and attempt < max_attempts:
                    delay = base_delay * (2 ** attempt)
                    retry_after = response.headers.get("Retry-After")
                    if retry_after:
                        try:
                            delay = float(retry_after)
                        except ValueError:
                            pass
                    else:
                        delay = delay * (0.5 + random.random() * 0.5)

                    time.sleep(delay)
                    continue

                # Parse RFC 7807 error
                try:
                    error_data = response.json()
                    error_msg = error_data.get("detail", error_data.get("title", "Request failed"))
                    error_code = error_data.get("error_code", "unknown_error")
                    request_id = error_data.get("request_id")
                    error_type = error_data.get("type")
                except ValueError:
                    error_msg = response.text
                    error_code = "unknown_error"
                    request_id = None
                    error_type = None

                raise map_error_code_to_exception(
                    message=error_msg,
                    error_code=error_code,
                    status=response.status_code,
                    request_id=request_id,
                    error_type=error_type,
                    detail=error_msg
                )

            except (requests.ConnectionError, requests.Timeout) as e:
                if attempt < max_attempts:
                    delay = base_delay * (2 ** attempt) * (0.5 + random.random() * 0.5)
                    time.sleep(delay)
                    continue
                raise e

    # --- Namespaces ---

    @property
    def notes(self):
        class NotesNamespace:
            def __init__(self, client):
                self.client = client

            def list(self, chain_id: Union[int, str], **kwargs):
                return self.client._request(
                    "GET",
                    "/v1/notes",
                    params={"chain_id": str(chain_id)},
                    chain_id=chain_id,
                    **kwargs
                )

            def generate(self, chain_id: int, asset: str, amount: str) -> dict:
                return generate_note(chain_id, asset, amount)

        return NotesNamespace(self)

    @property
    def deposits(self):
        class DepositsNamespace:
            def __init__(self, client):
                self.client = client

            def create(self, chain_id: Union[int, str], asset: str, amount: str, precommitment: str, **kwargs):
                return self.client._request(
                    "POST",
                    "/v1/deposits",
                    body={"chain_id": int(chain_id), "asset": asset, "amount": amount, "precommitment": precommitment},
                    chain_id=chain_id,
                    **kwargs
                )

            def confirm(self, deposit_id: str, tx_hash: str, chain_id: Union[int, str], **kwargs):
                return self.client._request(
                    "POST",
                    f"/v1/deposits/{deposit_id}/confirmation",
                    body={"tx_hash": tx_hash},
                    chain_id=chain_id,
                    **kwargs
                )

        return DepositsNamespace(self)

    @property
    def withdrawals(self):
        class WithdrawalsNamespace:
            def __init__(self, client):
                self.client = client

            def create(self, chain_id: Union[int, str], asset: str, recipient: str, amount: str, proof: dict, **kwargs):
                return self.client._request(
                    "POST",
                    "/v1/withdrawals",
                    body={"chain_id": int(chain_id), "asset": asset, "recipient": recipient, "amount": amount, "proof": proof},
                    chain_id=chain_id,
                    **kwargs
                )

            def confirm(self, withdrawal_id: str, tx_hash: str, chain_id: Union[int, str], **kwargs):
                return self.client._request(
                    "POST",
                    f"/v1/withdrawals/{withdrawal_id}/confirmation",
                    body={"tx_hash": tx_hash},
                    chain_id=chain_id,
                    **kwargs
                )

        return WithdrawalsNamespace(self)

    @property
    def consolidation(self):
        class ConsolidationNamespace:
            def __init__(self, client):
                self.client = client

            def create(self, chain_id: Union[int, str], asset: str, proof: dict, **kwargs):
                return self.client._request(
                    "POST",
                    "/v1/notes/consolidation",
                    body={"chain_id": int(chain_id), "asset": asset, "proof": proof},
                    chain_id=chain_id,
                    **kwargs
                )

            def confirm(self, consolidation_id: str, tx_hash: str, chain_id: Union[int, str], **kwargs):
                return self.client._request(
                    "POST",
                    f"/v1/notes/consolidation/{consolidation_id}/confirmation",
                    body={"tx_hash": tx_hash},
                    chain_id=chain_id,
                    **kwargs
                )

        return ConsolidationNamespace(self)

    @property
    def strategies(self):
        class StrategiesNamespace:
            def __init__(self, client):
                self.client = client

            def functions(self, **kwargs):
                # Agent discovery: catalog of strategy types + param schemas (API-key only, unmetered).
                return self.client._request("GET", "/v1/strategies/functions", **kwargs)

            def validate(self, strategy_data: dict, **kwargs):
                # Dry-run validity (semantic + crypto); free, unmetered.
                return self.client._request("POST", "/v1/strategies/validate", body=strategy_data, **kwargs)

            def create(self, strategy_data: dict, chain_id: Union[int, str], **kwargs):
                return self.client._request(
                    "POST",
                    "/v1/strategies",
                    body=strategy_data,
                    chain_id=chain_id,
                    **kwargs
                )

            def list(self, chain_id: Union[int, str], **kwargs):
                return self.client._request(
                    "GET",
                    "/v1/strategies",
                    params={"chain_id": str(chain_id)},
                    chain_id=chain_id,
                    **kwargs
                )

            def get(self, strategy_id: str, chain_id: Union[int, str], **kwargs):
                return self.client._request(
                    "GET",
                    f"/v1/strategies/{strategy_id}",
                    chain_id=chain_id,
                    **kwargs
                )

            def abort(self, strategy_id: str, chain_id: Union[int, str], **kwargs):
                return self.client._request(
                    "POST",
                    f"/v1/strategies/{strategy_id}/abort",
                    body={},
                    chain_id=chain_id,
                    **kwargs
                )

        return StrategiesNamespace(self)

    @property
    def account(self):
        class AccountNamespace:
            def __init__(self, client):
                self.client = client

            def usage(self, **kwargs):
                return self.client._request("GET", "/v1/account/usage", **kwargs)

        return AccountNamespace(self)

    @property
    def fees(self):
        class FeesNamespace:
            def __init__(self, client):
                self.client = client

            def quote(self, **kwargs):
                return self.client._request("GET", "/v1/fees/quote", **kwargs)

        return FeesNamespace(self)

    @property
    def fhe(self):
        class FheNamespace:
            def __init__(self, client):
                self.client = client

            def generate_keys(self) -> dict:
                return generate_fhe_key_pair()

            def encrypt(self, client_key: str, value: int) -> str:
                return encrypt_value_fhe(client_key, value)

        return FheNamespace(self)

    # --- Cursor Pagination Helper ---
    def paginate(
        self,
        fetch_page: Callable[[Optional[str]], dict],
        initial_cursor: Optional[str] = None
    ) -> Generator[Any, None, None]:
        cursor = initial_cursor
        while True:
            page = fetch_page(cursor)
            items = page.get("items", [])
            for item in items:
                yield item
            cursor = page.get("next_cursor")
            if not cursor:
                break
