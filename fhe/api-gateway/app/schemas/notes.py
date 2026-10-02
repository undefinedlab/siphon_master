"""Notes response schemas — field-whitelist. Secrets (ciphertext, iv, note secret) NEVER appear.

`GET /v1/notes` returns commitments/amounts only; the note secrets live client-side, encrypted.
"""
from typing import Literal

from pydantic import BaseModel


class NoteView(BaseModel):
    commitment: str
    nullifier_hash: str
    chain_id: int
    asset: str
    spent: str  # 'false' | 'pending' | 'true'


class NoteList(BaseModel):
    notes: list[NoteView]
    spendable_balance_by_asset: dict[str, str]


class DepositIntentRequest(BaseModel):
    chain_id: int
    asset: str
    amount: str
    precommitment: str



class DepositIntentResponse(BaseModel):
    deposit_id: str
    note_material_ref: str
    calldata: str
    vault_generation_id: str


class DepositConfirmationRequest(BaseModel):
    tx_hash: str


class WithdrawalProof(BaseModel):
    stateRoot: str
    aspRoot: str
    nullifierHashes: list[str]
    changeCommitment: str
    changeLabel: str
    pA: list[str]
    pB: list[list[str]]
    pC: list[str]


class WithdrawalRequest(BaseModel):
    chain_id: int
    asset: str
    recipient: str
    amount: str
    proof: WithdrawalProof


class WithdrawalResponse(BaseModel):
    status: Literal["submitted"]
    tx_hash: str


class WithdrawalConfirmationRequest(BaseModel):
    tx_hash: str


class ConsolidationProof(BaseModel):
    stateRoot: str
    aspRoot: str
    nullifierHashes: list[str]
    mergedCommitment: str | None = None
    changeCommitment: str | None = None
    mergedLabel: str
    pA: list[str]
    pB: list[list[str]]
    pC: list[str]


class ConsolidationRequest(BaseModel):
    chain_id: int
    asset: str
    proof: ConsolidationProof


class ConsolidationResponse(BaseModel):
    status: Literal["submitted"]
    tx_hash: str


class ConsolidationConfirmationRequest(BaseModel):
    tx_hash: str
