"""Typed client for the on-chain indexer (Ponder). Public pool state — leaves, root, size.

Note: pool state is also reachable via the executor's vault-index proxy; this direct indexer client
exists for reads that don't need to traverse the executor. Chain data is treated eventually
consistent (a `…/confirmation` applies the §7 confirmation threshold before mutating note state).
"""
from app.adapters.base import DownstreamClient


class IndexerClient:
    def __init__(self, *, base_urls: dict[int, str]):
        self._clients = {
            chain_id: DownstreamClient(base_url=url) for chain_id, url in base_urls.items()
        }

    def pool_state(self, *, chain_id: int, asset: str) -> dict:
        client = self._clients.get(chain_id)
        if client is None:
            from app.errors import BadRequest

            raise BadRequest("Unsupported indexer chain.")
        return client._request(
            "GET",
            "/leaves",
            params={"chainId": chain_id, "asset": asset, "limit": 1},
        )
