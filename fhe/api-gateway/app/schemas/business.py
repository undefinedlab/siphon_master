"""Minimal self-custody business API schemas."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.common import StrictModel
from app.schemas.platform import OperationView


class AccountCreateRequest(StrictModel):
    chain_id: int = Field(description="EIP-155 signing domain for the wallet authorization.")
    external_ref: str = Field(min_length=1, max_length=200)
    wallet_address: str | None = Field(
        default=None,
        description="Must match X-Wallet-Address. Omit to use the signing wallet.",
    )
    label: str | None = Field(default=None, max_length=200)
    subaccount: str | None = None


class AccountView(BaseModel):
    account_id: str
    external_ref: str
    label: str | None = None
    status: str
    control_mode: str = Field(description="Always self_custody on this resource.")
    wallet_address: str
    api_key_can_spend: bool = Field(
        description="Always false. API keys provide service access, never wallet authority."
    )
    subaccount_id: str | None = None
    note_count: int
    created_at: datetime


class AccountList(BaseModel):
    accounts: list[AccountView]


class UnsignedTransaction(BaseModel):
    chain_id: int
    to: str
    data: str
    value: str = Field(description="Native wei, encoded as a base-10 string.")
    purpose: str


class SolanaTransaction(BaseModel):
    chain_id: int
    encoding: Literal["base64"] = "base64"
    transaction: str = Field(description="Unsigned legacy transaction, fee payer = the account wallet. Sign and send it.")
    purpose: str
    last_valid_block_height: int | None = Field(default=None, description="The blockhash expires after this height (~60s).")


class AccountDepositRequest(StrictModel):
    chain_id: int = Field(description="8453 (Base), 42161 (Arbitrum One), 900002 (Solana Devnet) or 11155111 (Sepolia, sandbox keys).")
    asset: str = Field(description="ETH, WETH or USDC (EVM); SOL or USDC (Solana Devnet). ETH is held as WETH, SOL as WSOL.")
    amount_minor: int = Field(gt=0, description="Base units (wei, lamports, or 6-decimal USDC units).")
    precommitment: str = Field(
        pattern=r"^[0-9]{1,78}$",
        description="Poseidon(nullifier, secret) from @siphon/sdk-ts prepareDeposit(), decimal. The secrets stay client-side.",
    )
    user_salt: str = Field(
        pattern=r"^[0-9]{1,78}$",
        description="The deposit's userSalt from prepareDeposit(). Public once the deposit is mined (it is a "
        "deposit() argument); the compliance service needs it to screen and admit the deposit."
    )
    commitment: str | None = Field(
        default=None,
        pattern=r"^[0-9]{1,78}$",
        description="Solana Devnet only (required there): the note commitment, decimal, built with the vault's current "
        "deposit_nonce (GET /v1/chains/900002/vault). The program rejects a stale one; recompute and retry.",
    )


class DepositScreening(BaseModel):
    decision: Literal["admit"] = Field(description="Only admitted deposits get a deposit transaction.")
    fee_paid: bool = True


class AccountDepositResponse(BaseModel):
    operation: OperationView | None = Field(default=None, description="Created in the deposit phase.")
    phase: Literal["approve", "deposit"] = Field(
        description="approve: send the approval, then call again with a new Idempotency-Key. "
        "deposit: screening passed; send the deposit transaction, then POST /v1/operations/{id}/submission."
    )
    commitment: str | None = Field(default=None, description="The note commitment the kernel will mint (deposit phase).")
    screening: DepositScreening | None = None
    transactions: list[UnsignedTransaction | SolanaTransaction] = Field(description="Submit in order from the account wallet.")


class SpendBundle(StrictModel):
    """The output of @siphon/sdk-ts prepareWithdrawal(): both halves of a v5 spend."""

    public_inputs: list[str] = Field(min_length=25, max_length=25)
    proof: list[str] = Field(min_length=8, max_length=8, description="Groth16, flat, G2 coordinates swapped.")
    compliancePublicInputs: list[str] = Field(min_length=5, max_length=5)
    complianceProof: list[str] = Field(min_length=8, max_length=8)
    extra: dict[str, str] = Field(description="{ rawPayee: recipient address }")


class SolanaSpend(StrictModel):
    """A client-proved Solana Devnet spend (@siphon/sdk-ts `solana`): the 25 public limbs and the
    Groth16 proof. No compliance half — the program checks the roots in the limbs directly."""

    public_inputs: list[str] = Field(min_length=25, max_length=25, description="Decimal limbs, circuit order.")
    proof_hex: str = Field(description="256 bytes: A | B (G2 coordinates c1‖c0) | C, big-endian, hex.")
    circuit_index: int = Field(ge=0, le=13, description="VK slot: withdrawN → N-1, split → 12.")


class PayoutRequest(StrictModel):
    chain_id: int
    account_id: str
    asset: str
    recipient: str
    amount_minor: int = Field(gt=0)
    spend: SpendBundle | None = Field(default=None, description="EVM chains: the v5 spend bundle.")
    solana_spend: SolanaSpend | None = Field(default=None, description="Solana Devnet: the withdraw proof.")
    reference: str | None = Field(default=None, max_length=200)
    submission_mode: Literal["relay", "unsigned"] = Field(
        default="relay",
        description="relay preserves withdrawal unlinkability; unsigned is for an independent relayer.",
    )


class PayoutResponse(BaseModel):
    operation: OperationView
    submission_mode: Literal["relay", "unsigned"]
    transaction: UnsignedTransaction | None = Field(
        default=None,
        description="Present in unsigned mode. Do not submit from the source wallet; use an independent relayer.",
    )
    tx_hash: str | None = Field(default=None, description="Present after relay submission.")


class SplitRequest(StrictModel):
    """Split one Solana Devnet note into up to 8 slices under its label (for multi-leg orders)."""

    chain_id: int = Field(description="900002 — splits are relayed on Solana Devnet only.")
    account_id: str
    solana_spend: SolanaSpend
    split_commitments: list[str] = Field(min_length=8, max_length=8,
                                         description="The 8 slice commitments, decimal, 0 for unused slots.")


class SplitResponse(BaseModel):
    operation: OperationView
    tx_hash: str | None = Field(default=None, description="The spend_split transaction signature.")


class WalletChallengeResponse(BaseModel):
    nonce: str
    message: str
    expires_at: int | None = None
    ttl_seconds: int | None = None


class OperationSubmissionRequest(StrictModel):
    chain_id: int
    tx_hash: str = Field(description="Hash of the exact transaction returned by Siphon.")
