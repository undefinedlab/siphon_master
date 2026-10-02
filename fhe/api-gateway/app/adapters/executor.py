"""Typed client for the internal trade-executor.

User routes (strategy create/list/abort, FHE key upload, relay withdraw/merge) are write-challenge
gated on the hardened executor and REJECT the internal X-API-TOKEN — so the gateway forwards the
USER's wallet/write-challenge headers (`wallet_headers`) on those. Only the executor-internal proxy
routes (vault-index) carry the X-API-TOKEN (`internal=True`).
"""
from app.adapters.base import DownstreamClient
from app.errors import ProofFailed


class ExecutorClient(DownstreamClient):
    def _as_client_error(self, resp):
        # The executor reserves 422 for deterministic proof/nullifier rejection. Retrying cannot
        # succeed, and SDKs need the stable proof_failed code rather than generic bad_request.
        if resp.status_code == 422:
            try:
                message = (resp.json() or {}).get("error")
            except Exception:
                message = None
            return ProofFailed(message if isinstance(message, str) else "Proof was rejected.")
        return super()._as_client_error(resp)

    # --- Confidential strategies (user routes — forward wallet headers, NOT the api token) ---
    def create_strategy(self, payload: dict, *, wallet_headers: dict[str, str]) -> dict:
        headers = dict(wallet_headers)
        if self._api_token:
            # Distinct header: the executor rejects X-API-TOKEN on user routes, but still needs an
            # unforgeable assertion that createStrategy traversed the metered gateway.
            headers["X-Siphon-Gateway-Token"] = self._api_token
        return self._request("POST", "/createStrategy", json=payload, headers=headers)

    def list_strategies(self, user_id: str, *, wallet_headers: dict[str, str]) -> dict:
        return self._request("GET", f"/strategies/{user_id}", headers=wallet_headers)

    def get_strategy_result(self, strategy_id: str, *, wallet_headers: dict[str, str]) -> dict:
        return self._request("GET", f"/strategy/{strategy_id}/result", headers=wallet_headers)

    def abort_strategy(self, strategy_id: str, *, wallet_headers: dict[str, str]) -> dict:
        return self._request("POST", f"/strategies/{strategy_id}/abort", headers=wallet_headers)

    # --- FHE keys (user routes) ---
    def upload_server_key(self, user_id: str, server_key: str, canary: str, *, wallet_headers: dict[str, str]) -> dict:
        return self._request("POST", "/uploadServerKey",
                             json={"user_id": user_id, "server_key": server_key, "canary": canary},
                             headers=wallet_headers)

    def has_server_key(self, user_id: str, *, wallet_headers: dict[str, str] | None = None) -> dict:
        # Gateway preflight is an internal service read. Reusing the browser route would require a
        # second legacy v1 signature alongside the exact v2 mutation intent.
        return self._request("GET", f"/internal/hasServerKey/{user_id}", internal=True)

    # --- Relayer-submitted fund moves (user routes, write-challenge gated) ---
    def issue_wallet_challenge(self, chain_id: int) -> dict:
        """A write nonce bound to `chain_id` (OVERLORD G-8): the executor only issues one for a
        chain it serves, and the wallet signs `Siphon auth v2:write:<chain_id>:<nonce>`."""
        return self._request("POST", "/auth/challenge", json={"chain_id": int(chain_id)})

    def relay_spend(self, body: dict, *, wallet_headers: dict[str, str]) -> dict:
        """v5 VaultKernel.spend relay (write-challenge gated). Body: chain_id, public_inputs[25],
        proof[8], compliancePublicInputs[5], complianceProof[8], extra{rawPayee}."""
        from app.config import get_settings

        return self._request("POST", "/relaySpend", json=body, headers=wallet_headers,
                             timeout=get_settings().relay_timeout_seconds)

    def relay_solana(self, body: dict, *, wallet: str, request_id: str | None = None) -> dict:
        """Solana Devnet withdraw/split relay. The gateway already verified the wallet's ed25519
        intent; the executor trusts that only with the gateway attestation header."""
        from app.config import get_settings

        headers = {"X-Wallet-Address": wallet, "X-Siphon-Gateway-Token": self._api_token or ""}
        if request_id:
            headers["X-Request-ID"] = request_id
        return self._request("POST", "/solana/relayWithdraw", json=body, headers=headers,
                             timeout=get_settings().relay_timeout_seconds)

    def relay_withdraw(self, body: dict, *, wallet_headers: dict[str, str]) -> dict:
        return self._request("POST", "/relayWithdraw", json=body, headers=wallet_headers)

    def prepare_relay_submission(
        self, relay_id: str, body: dict, *, wallet: str
    ) -> dict:
        return self._request(
            "POST",
            f"/internal/relay-submissions/{relay_id}/prepare",
            json={"wallet": wallet, "payload": body},
            internal=True,
        )

    def relay_submission(self, relay_id: str) -> dict:
        return self._request("GET", f"/internal/relay-submissions/{relay_id}", internal=True)

    def recover_relay_submission(self, relay_id: str) -> dict:
        return self._request(
            "POST", f"/internal/relay-submissions/{relay_id}/recover", internal=True
        )

    def relay_merge(self, body: dict, *, wallet_headers: dict[str, str]) -> dict:
        return self._request("POST", "/relayMerge", json=body, headers=wallet_headers)

    # --- Vault-index proxy (internal route — carries X-API-TOKEN) ---
    def vault_index_leaves(self, *, chain_id: int, asset: str) -> dict:
        return self._request("GET", "/vault-index/leaves",
                             params={"chain_id": chain_id, "asset": asset}, internal=True)

    def vault_index_find(self, *, chain_id: int, asset: str, commitment: str) -> dict:
        return self._request("GET", "/vault-index/find",
                             params={"chain_id": chain_id, "asset": asset, "commitment": commitment},
                             internal=True)

    def vault_balance(self, *, chain_id: int, asset: str) -> dict:
        return self._request("GET", "/vault-index/balance",
                             params={"chain_id": chain_id, "asset": asset}, internal=True)

    def execution_events(self) -> list[dict]:
        return self._request("GET", "/execution-events", internal=True)
