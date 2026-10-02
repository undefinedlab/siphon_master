"""Pool response schemas (field-whitelist — no secrets)."""
from pydantic import BaseModel


class PoolState(BaseModel):
    chain_id: int
    asset: str
    root: str
    size: int
    leaves_count: int
