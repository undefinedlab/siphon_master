"""Typed client for the internal proving-relayer (rapidsnark). One route: POST /prove."""
from app.adapters.base import DownstreamClient


class RelayerClient(DownstreamClient):
    def prove(self, proof_input: dict) -> dict:
        return self._request("POST", "/prove", json=proof_input, internal=True)
