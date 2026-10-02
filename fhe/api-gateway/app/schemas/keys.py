from pydantic import BaseModel, Field


class CreditPack(BaseModel):
    id: str
    label: str
    usdc_minor: int
    plan: str


class PacksResponse(BaseModel):
    packs: list[CreditPack]
    collector: str
    usdc_by_chain: dict[str, str]
    min_custom_usdc_minor: int = Field(
        ...,
        description="Minimum USDC minor units when pack_id is 'custom'",
    )


class PurchaseRequest(BaseModel):
    chain_id: int = Field(..., description="EVM chain id (8453 Base, 42161 Arbitrum One or 11155111 Sepolia)")
    pack_id: str = Field(..., min_length=1)
    tx_hash: str = Field(..., min_length=66, max_length=66, pattern=r"^0x[0-9a-fA-F]{64}$")
    usdc_minor: int | None = Field(
        None,
        ge=1,
        description="Required when pack_id is 'custom'; ignored for fixed packs",
    )
    delivery_key_sha256: str = Field(
        ...,
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-fA-F]{64}$",
        description="SHA-256 of the temporary X-Delivery-Key used for loss-safe key delivery",
    )


class PurchaseResponse(BaseModel):
    api_key: str = Field(
        ...,
        description="Plaintext key returned during acquisition; move it to backend secret storage.",
    )
    api_key_id: str
    plan: str
    balance_minor: int
    pack_id: str
    tx_hash: str
    collector: str
    usdc: str


class KeySummary(BaseModel):
    api_key_id: str
    plan: str
    status: str
    balance_minor: int
    credited_minor: int = Field(
        0,
        description="Lifetime prepaid credit (purchases + grants); used for consumption UI",
    )
    created_at: str | None = None


class KeysListResponse(BaseModel):
    keys: list[KeySummary]
    collector: str


class DevnetKeyRequest(BaseModel):
    chain_id: int = Field(900002, description="Always 900002: a free key works on Solana Devnet only.")
    delivery_key_sha256: str = Field(
        ...,
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-fA-F]{64}$",
        description="SHA-256 of the temporary X-Delivery-Key used for loss-safe key delivery",
    )


class DevnetKeyResponse(BaseModel):
    api_key: str = Field(..., description="Plaintext key, shown once. Claiming again revokes it and issues a new one.")
    api_key_id: str
    plan: str = Field(..., description="Always devnet.")
    chain_ids: list[int] = Field(..., description="The chains this key may use: [900002].")
    revoked_previous: int = Field(..., description="Earlier Devnet keys of this wallet revoked by this claim.")
