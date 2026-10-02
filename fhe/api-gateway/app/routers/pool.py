"""Public pool state — leaves, root, size for a (chain, asset).

API-key gated + read-rate-limited; no wallet sig (pool state is public). Thin handler: it delegates
to the vault-index proxy and maps the response to the PoolState field-whitelist.
"""
from fastapi import APIRouter, Depends

from app.adapters.executor import ExecutorClient
from app.deps.api_key import verify_api_key
from app.deps.clients import get_executor_client
from app.deps.rate_limit import rate_limit
from app.schemas.common import Problem
from app.schemas.errors_openapi import COMMON_ERRORS
from app.schemas.pool import PoolState

router = APIRouter(prefix="/v1", tags=["Pool"])


@router.get(
    "/pool/{chain}/{asset}",
    operation_id="getPoolState",
    summary="Public pool state (leaves, root, size) for a chain/asset",
    response_model=PoolState,
    responses=COMMON_ERRORS,
)
async def get_pool_state(
    chain: int,
    asset: str,
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
    executor: ExecutorClient = Depends(get_executor_client),
) -> PoolState:
    data = executor.vault_index_leaves(chain_id=chain, asset=asset.upper())
    return PoolState(
        chain_id=chain,
        asset=asset.upper(),
        root=str(data.get("root", "")),
        size=int(data.get("size", 0)),
        leaves_count=int(data.get("leaves_count", data.get("size", 0))),
    )
