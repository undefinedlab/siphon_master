"""Strategy + FHE-key request/response schemas (field-whitelist; no secrets)."""
from pydantic import Field

from app.schemas.common import StrictModel


class FheServerKeyUpload(StrictModel):
    server_key: str  # hex, size-capped before parsing; re-derivable client-side from the ClientKey
    canary: str      # hex(encrypt(0)) under this generation's ClientKey


class FheKeysStatus(StrictModel):
    server_key_present: bool
    fingerprint: str | None = None


class StrategyValidateRequest(StrictModel):
    strategy_type: str
    chain_id: int
    amount: float
    vault_generation_id: str | None = None
    encrypted_upper_bound: str | None = None
    encrypted_lower_bound: str | None = None


class StrategyValidateResponse(StrictModel):
    valid: bool
    errors: list[str]


class StrategyFunction(StrictModel):
    name: str
    params_schema: dict


class StrategyFunctions(StrictModel):
    types: list[StrategyFunction]


class StrategyView(StrictModel):
    id: str
    strategy_type: str | None = None
    asset_in: str | None = None
    asset_out: str | None = None
    amount: float | None = None
    status: str  # gateway lifecycle name (mapped from the executor status)
    tx_hash: str | None = None
    executed_at: str | None = None
    created_at: str | None = None
    vault_generation_id: str | None = None
    from_chain: str | None = None
    execution_error: str | None = None
    settlement: dict | None = Field(
        default=None,
        description="Solana Devnet: the settlement record. `returned_note` {commitment, deposit_nonce, leaf_index, "
        "amount, mint} is the vault note the fill minted for you; `waiting` is NEEDS_REPROOF when roots moved.",
    )
    legs: list[dict] | None = Field(default=None, description="Solana Devnet multi-leg orders: per-leg status and settlement.")


class StrategyReproveRequest(StrictModel):
    zkp_data: dict = Field(description="A fresh spend package for the same note (new roots), as sent at arm time.")
    leg_index: int | None = Field(default=None, ge=0, description="Multi-leg orders: the leg to re-prove.")


class StrategyList(StrictModel):
    strategies: list[StrategyView]


class FheClientKeyUpload(StrictModel):
    """The FHE client key for the confidential decryptor — SEALED to its attested key
    (GET /v1/fhe-keys/attestation) when the decryptor requires it. It decrypts only trigger bits."""
    client_key: str


class FheSelfCheck(StrictModel):
    encrypted_canary: str = Field(description="encrypt(0) under the client key; the decryptor must read it back as triggered.")
