"""Request/response models for the platform surface: operations, webhooks, subaccounts,
compliance receipts, batches, and policy.

Request bodies inherit StrictModel (extra='forbid') so a typo'd field is a 422 at the edge rather
than a silently-ignored instruction — which for a policy or a spend cap would be a security bug.
"""
from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import StrictModel

# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------


class OperationView(BaseModel):
    operation_id: str
    kind: str = Field(description="withdrawal | deposit | payout | split | consolidation | strategy")
    status: str = Field(description="Business operation state.", examples=["submitted"])
    phase: str = Field(
        description="Stable client lifecycle: pending | action_required | processing | succeeded | failed."
    )
    chain_id: int | None = None
    asset: str | None = None
    amount_minor: int | None = None
    recipient: str | None = None
    tx_hash: str | None = None
    batch_id: str | None = None
    subaccount_id: str | None = None
    account_id: str | None = None
    next_action: str | None = Field(
        default=None, description="Client action required before Siphon can observe confirmation."
    )
    error_code: str | None = None
    retryable: bool = False
    admission: str | None = Field(
        default=None,
        description="v5 deposits: pending → admitted once the ASP admits the label (spendable). "
        "rejected / refused / expired need attention; the funds can always leave by ragequit.",
    )
    created_at: datetime
    updated_at: datetime


class OperationList(BaseModel):
    operations: list[OperationView]
    next_cursor: str | None = Field(
        default=None, description="Pass as ?cursor= to fetch the next page. Null when exhausted."
    )


# ---------------------------------------------------------------------------
# Webhooks
# ---------------------------------------------------------------------------


class WebhookCreateRequest(StrictModel):
    url: str = Field(description="HTTPS endpoint that receives signed events.")
    events: list[str] | None = Field(
        default=None,
        description="Event types to receive, e.g. ['operation.confirmed']. Omit or ['*'] for all.",
        examples=[["operation.confirmed", "operation.failed"]],
    )
    description: str | None = None


class WebhookView(BaseModel):
    webhook_id: str
    url: str
    events: list[str]
    status: str
    description: str | None = None
    created_at: datetime


class WebhookCreateResponse(WebhookView):
    secret: str = Field(
        description="Signing secret — shown EXACTLY once. Store it; it is never echoed again."
    )


class WebhookList(BaseModel):
    webhooks: list[WebhookView]


class DeliveryView(BaseModel):
    delivery_id: str
    endpoint_id: str
    operation_id: str | None = None
    event_type: str
    status: str
    attempts: int
    response_status: int | None = None
    last_error: str | None = None
    created_at: datetime
    delivered_at: datetime | None = None


class DeliveryList(BaseModel):
    deliveries: list[DeliveryView]


# ---------------------------------------------------------------------------
# Subaccounts
# ---------------------------------------------------------------------------


class SubaccountCreateRequest(StrictModel):
    external_id: str = Field(description="Your own identifier for this tenant. Unique per API key.")
    label: str | None = None
    spend_cap_minor: int | None = Field(
        default=None, ge=0, description="Hard spend ceiling in minor units. Omit for uncapped."
    )
    rate_limit_per_min: int | None = Field(
        default=None, ge=1, description="Per-subaccount request budget. Omit to inherit the key's."
    )


class SubaccountUpdateRequest(StrictModel):
    label: str | None = None
    status: str | None = Field(default=None, description="active | suspended")
    spend_cap_minor: int | None = Field(default=None, ge=0)
    rate_limit_per_min: int | None = Field(default=None, ge=1)


class SubaccountView(BaseModel):
    subaccount_id: str
    external_id: str
    label: str | None = None
    status: str
    spend_cap_minor: int | None = None
    spent_minor: int = Field(description="Settled debits against this subaccount.")
    reserved_minor: int = Field(
        default=0, description="Authorized but not yet settled; counts against the cap."
    )
    remaining_minor: int | None = Field(
        default=None, description="cap - (spent + reserved). Null when uncapped."
    )
    rate_limit_per_min: int | None = None
    created_at: datetime


class SubaccountList(BaseModel):
    subaccounts: list[SubaccountView]


# ---------------------------------------------------------------------------
# Compliance receipts
# ---------------------------------------------------------------------------


class ReceiptView(BaseModel):
    receipt_id: str
    operation_id: str | None = None
    subject_address: str
    chain_id: int | None = None
    result: str = Field(description="pass | deny")
    list_version: str | None = None
    asp_root: str | None = None
    attestation_digest: str | None = None
    policy_version: int | None = None
    screened_at: datetime
    signature: str
    key_id: str


class ReceiptList(BaseModel):
    receipts: list[ReceiptView]


class ReceiptExport(BaseModel):
    payload: dict
    signature: str
    algorithm: str
    key_id: str
    canonicalization: str
    verify: str


class ReceiptVerifyResponse(BaseModel):
    receipt_id: str
    valid: bool
    key_id: str


# ---------------------------------------------------------------------------
# Batches
# ---------------------------------------------------------------------------


class BatchItem(StrictModel):
    recipient: str
    amount_minor: int = Field(gt=0)
    reference: str | None = Field(
        default=None, description="Your own line reference, echoed back on the item's operation."
    )


class BatchCreateRequest(StrictModel):
    chain_id: int
    asset: str
    items: list[BatchItem] = Field(min_length=1, max_length=500)
    subaccount: str | None = Field(
        default=None, description="Subaccount id or your external_id to charge."
    )
    kind: str = Field(default="payout", description="payout | payroll | settlement")


class BatchView(BaseModel):
    batch_id: str
    kind: str
    status: str
    chain_id: int
    asset: str
    item_count: int
    total_amount_minor: int
    subaccount_id: str | None = None
    counts_by_state: dict[str, int]
    created_at: datetime
    updated_at: datetime


class BatchDetail(BatchView):
    items: list[OperationView]


class BatchList(BaseModel):
    batches: list[BatchView]


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------


class PolicyPutRequest(StrictModel):
    rules: dict = Field(
        description="Control set. Unknown rule names are rejected.",
        examples=[{"min_anonymity_set": 50, "allowed_chains": [8453], "max_amount_minor": 1_000_000}],
    )


class PolicyView(BaseModel):
    version: int
    status: str
    rules: dict
    created_by: str | None = None
    created_at: datetime


class PolicyHistory(BaseModel):
    policies: list[PolicyView]


class PolicyEvaluateRequest(StrictModel):
    chain_id: int | None = None
    asset: str | None = None
    amount_minor: int | None = None
    recipient: str | None = None
    subaccount: str | None = None


class PolicyEvaluateResponse(BaseModel):
    allowed: bool
    violations: list[str]
    policy_version: int | None = None


# ---------------------------------------------------------------------------
# Managed accounts (enclave-custodied shielded accounts)
# ---------------------------------------------------------------------------


class ManagedAccountCreateRequest(StrictModel):
    external_ref: str = Field(description="Your own identifier for this account. Unique per API key.")
    label: str | None = None
    subaccount: str | None = Field(
        default=None, description="Subaccount id or external_id this account bills to."
    )


class ManagedAccountView(BaseModel):
    account_id: str
    external_ref: str
    label: str | None = None
    status: str
    owner_address: str | None = Field(
        default=None,
        description="EVM address derived inside the enclave. Payout destination and the "
                    "DepositInfo.depositor holding ragequit authority. The key never leaves the enclave.",
    )
    fingerprint: str = Field(description="Non-reversible identifier for the account's key material.")
    subaccount_id: str | None = None
    note_count: int
    balance_minor: int = Field(description="Confirmed, unspent value. Pending deposits are excluded.")
    created_at: datetime


class ManagedAccountList(BaseModel):
    accounts: list[ManagedAccountView]


class ManagedNoteView(BaseModel):
    note_id: str
    index: int
    chain_id: int
    asset: str
    amount_minor: int
    label: str
    commitment: str
    precommitment: str
    nullifier_hash: str
    status: str = Field(description="pending | confirmed | spent")
    tx_hash: str | None = None
    created_at: datetime


class ManagedNoteList(BaseModel):
    notes: list[ManagedNoteView]


class ManagedDepositRequest(StrictModel):
    chain_id: int
    asset: str
    amount_minor: int = Field(gt=0)


class ManagedDepositResponse(BaseModel):
    operation_id: str
    account_id: str
    note: ManagedNoteView
    deposit_address: str = Field(description="Entrypoint contract to send the deposit transaction to.")
    calldata: str = Field(
        description="ABI-encoded deposit() call. Submit it from any funded wallet; no note secrets "
                    "or cryptography are required on your side."
    )
    value: str = Field(description="Wei to attach (native-asset deposits), else '0'.")


class ManagedDepositConfirmRequest(StrictModel):
    tx_hash: str


class ManagedRecoveryResponse(BaseModel):
    account_id: str
    scanned: int
    notes: list[dict] = Field(
        description="Re-derived note commitments for the scanned index range. Match these against "
                    "the on-chain tree to rebuild an account whose note index was lost."
    )
