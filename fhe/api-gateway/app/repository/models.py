"""Gateway Postgres models — the durable billing/metering truth (spec §8).

Money is BIGINT minor units (never float); all timestamps are TIMESTAMPTZ UTC; constraints are
declared aggressively (FK, UNIQUE, CHECK, NOT NULL). These live alongside — not inside — the
executor's own SQLAlchemy models; the gateway only reads executor tables via its adapters.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# JSONB on Postgres (prod), JSON on SQLite (in-memory unit tests) — same Python dict interface.
JSONType = JSONB().with_variant(JSON(), "sqlite")


def _uid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class ApiKey(Base):
    """An integrator's API key — who pays. Stored only as an HMAC hash, never plaintext."""
    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    key_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    integrator_id: Mapped[str] = mapped_column(String, nullable=False)
    plan: Mapped[str] = mapped_column(String, nullable=False)  # test|starter|growth|enterprise
    # Prepaid balance in integer minor units. Unused in v1 (manual invoicing); a credit grant
    # (§5.4) increments it, and automated debit draws it down in v1.1 — no migration needed.
    balance_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String, nullable=False, default="active")  # active|revoked|expired
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("balance_minor >= 0", name="ck_apikey_balance_nonneg"),
        Index("ix_apikey_integrator", "integrator_id"),
        Index("ix_apikey_status", "status"),
    )


class UsageEvent(Base):
    """Append-only metering ledger (spec §5.1). The UNIQUE(event_type, tx_hash) makes an
    executor-emitted `execution` event idempotent at the DB level — a replayed on-chain event
    can't double-bill."""
    __tablename__ = "usage_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    api_key_id: Mapped[str] = mapped_column(String, ForeignKey("api_keys.id"), nullable=False)
    event_type: Mapped[str] = mapped_column(String, nullable=False)  # strategy_created|execution|withdrawal
    strategy_id: Mapped[str | None] = mapped_column(String)
    tx_hash: Mapped[str | None] = mapped_column(String)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    request_id: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("event_type", "tx_hash", name="uq_usage_event_txhash"),
        Index("ix_usage_key_time", "api_key_id", "created_at"),
        Index("ix_usage_type", "event_type"),
    )


class IdempotencyKey(Base):
    """Postgres-authoritative idempotency store (spec §5.3). Redis is only a read-through cache in
    front of this — never a second source of truth."""
    __tablename__ = "idempotency_keys"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    response_body: Mapped[dict | None] = mapped_column(JSONType)
    status_code: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String, nullable=False, default="in_progress")  # in_progress|completed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)


class CreditLedger(Base):
    """Append-only credit ledger — the billing source of truth.

    `ApiKey.balance_minor` is a materialized cache of `SUM(amount_minor)` over this table for the
    key. Entries use typed columns (never JSON `detail`) so aggregates are indexable and, critically,
    so a balance can never be changed by an audit-log retention or compaction policy. The audit log
    stays the security trail; it is no longer the billing arithmetic.

    `amount_minor` is signed: positive credits (grant, purchase), negative debits.
    """
    __tablename__ = "credit_ledger"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    api_key_id: Mapped[str] = mapped_column(String, ForeignKey("api_keys.id"), nullable=False)
    # Optional tenant scope. NULL = the key's own pooled balance; set = charged to one subaccount,
    # which is what makes per-tenant spend caps enforceable from the same ledger.
    subaccount_id: Mapped[str | None] = mapped_column(String, ForeignKey("subaccounts.id"))
    kind: Mapped[str] = mapped_column(String, nullable=False)  # grant|purchase|debit|migration
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    balance_after: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    request_id: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (
        CheckConstraint("balance_after >= 0", name="ck_ledger_balance_nonneg"),
        Index("ix_ledger_key_time", "api_key_id", "created_at"),
        Index("ix_ledger_key_kind", "api_key_id", "kind"),
        Index("ix_ledger_subaccount", "subaccount_id", "created_at"),
    )


class AuditLog(Base):
    """Immutable, append-only audit trail for security-sensitive ops (never UPDATE/DELETE)."""
    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    actor: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)  # e.g. credit.grant, withdrawal, key.revoke
    target: Mapped[str | None] = mapped_column(String)
    # Structured context, e.g. {amount_minor, reason, balance_before, balance_after} for credit.grant.
    detail: Mapped[dict | None] = mapped_column(JSONType)
    request_id: Mapped[str] = mapped_column(String, nullable=False)
    result: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)


class Subaccount(Base):
    """One end-user / tenant inside an integrator's API key.

    A platform serving many users needs isolation without minting a key per user: separate spend
    caps, separate rate-limit budgets, separate operation scoping. `external_id` is the integrator's
    own identifier for the tenant, so they can address a subaccount without storing our ids.

    `spend_cap_minor` NULL = uncapped (draws on the key's pooled balance). Spend is derived from
    credit_ledger rows scoped to this subaccount — never a counter that can drift.
    """
    __tablename__ = "subaccounts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    api_key_id: Mapped[str] = mapped_column(String, ForeignKey("api_keys.id"), nullable=False)
    external_id: Mapped[str] = mapped_column(String, nullable=False)
    label: Mapped[str | None] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, nullable=False, default="active")  # active|suspended
    spend_cap_minor: Mapped[int | None] = mapped_column(BigInteger)
    # Per-subaccount rate budget; NULL inherits the key's class limits.
    rate_limit_per_min: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("api_key_id", "external_id", name="uq_subaccount_external"),
        CheckConstraint("spend_cap_minor IS NULL OR spend_cap_minor >= 0", name="ck_subaccount_cap_nonneg"),
        Index("ix_subaccount_key", "api_key_id", "status"),
    )


class Operation(Base):
    """The durable, pollable record of one asynchronous fund-moving action.

    Before this, each flow (withdrawal / deposit / consolidation / strategy) had its own two-phase
    create + `…/confirmation` pair and no queryable object in between, so an integrator could only
    discover state by re-driving the call that created it. An Operation is created at intent time and
    transitions through `BusinessOperationState`; webhooks fire off its transitions.
    """
    __tablename__ = "operations"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    api_key_id: Mapped[str] = mapped_column(String, ForeignKey("api_keys.id"), nullable=False)
    subaccount_id: Mapped[str | None] = mapped_column(String, ForeignKey("subaccounts.id"))
    batch_id: Mapped[str | None] = mapped_column(String, ForeignKey("batches.id"))
    kind: Mapped[str] = mapped_column(String, nullable=False)  # withdrawal|deposit|consolidation|strategy
    state: Mapped[str] = mapped_column(String, nullable=False, default="created")
    chain_id: Mapped[int | None] = mapped_column(Integer)
    asset: Mapped[str | None] = mapped_column(String)
    amount_minor: Mapped[int | None] = mapped_column(BigInteger)
    # Never a raw recipient in the clear alongside the amount — see operation_service.public_view.
    recipient: Mapped[str | None] = mapped_column(String)
    tx_hash: Mapped[str | None] = mapped_column(String)
    wallet: Mapped[str | None] = mapped_column(String)
    error_code: Mapped[str | None] = mapped_column(String)
    detail: Mapped[dict | None] = mapped_column(JSONType)
    retryable: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # 0/1, SQLite-friendly
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    last_chain_check_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("ix_operation_key_time", "api_key_id", "created_at"),
        Index("ix_operation_state", "api_key_id", "state"),
        Index("ix_operation_tx", "tx_hash"),
        Index("ix_operation_batch", "batch_id"),
        Index("ix_operation_subaccount", "subaccount_id", "created_at"),
        Index("ix_operation_chain_check", "state", "last_chain_check_at"),
    )


class Batch(Base):
    """One authorization over many recipients — payroll, payouts, settlement runs.

    The batch is the unit an integrator authorizes and is billed for; each entry becomes an
    Operation carrying `batch_id`, so per-item state and per-item failure are visible without
    losing the atomic-authorization semantics at the top.
    """
    __tablename__ = "batches"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    api_key_id: Mapped[str] = mapped_column(String, ForeignKey("api_keys.id"), nullable=False)
    subaccount_id: Mapped[str | None] = mapped_column(String, ForeignKey("subaccounts.id"))
    kind: Mapped[str] = mapped_column(String, nullable=False, default="payout")
    state: Mapped[str] = mapped_column(String, nullable=False, default="created")
    chain_id: Mapped[int] = mapped_column(Integer, nullable=False)
    asset: Mapped[str] = mapped_column(String, nullable=False)
    item_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    wallet: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (
        Index("ix_batch_key_time", "api_key_id", "created_at"),
    )


class WebhookEndpoint(Base):
    """An integrator's HTTPS sink for operation state transitions.

    NOTE on `secret`: unlike an API key (stored only as an HMAC hash), a webhook signing secret is a
    SHARED secret — the gateway must reproduce it to sign every outbound delivery, so it cannot be
    one-way hashed. It grants no access to this API; its only power is to authenticate our payloads
    to the integrator. It is returned exactly once at creation and never echoed again.
    """
    __tablename__ = "webhook_endpoints"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    api_key_id: Mapped[str] = mapped_column(String, ForeignKey("api_keys.id"), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    secret: Mapped[str] = mapped_column(Text, nullable=False)
    # Subscribed event types, e.g. ["operation.confirmed", "operation.failed"]; ["*"] = all.
    events: Mapped[list | None] = mapped_column(JSONType)
    status: Mapped[str] = mapped_column(String, nullable=False, default="active")  # active|disabled
    description: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (
        Index("ix_webhook_key", "api_key_id", "status"),
    )


class WebhookDelivery(Base):
    """One attempt-tracked delivery of one event to one endpoint.

    Persisted BEFORE the HTTP attempt so a crash mid-delivery is retried rather than lost, and so an
    integrator can audit exactly what we sent and what came back.
    """
    __tablename__ = "webhook_deliveries"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    endpoint_id: Mapped[str] = mapped_column(String, ForeignKey("webhook_endpoints.id"), nullable=False)
    api_key_id: Mapped[str] = mapped_column(String, ForeignKey("api_keys.id"), nullable=False)
    operation_id: Mapped[str | None] = mapped_column(String, ForeignKey("operations.id"))
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict | None] = mapped_column(JSONType)
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")  # pending|delivered|failed
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    response_status: Mapped[int | None] = mapped_column(Integer)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("ix_delivery_pending", "status", "next_attempt_at"),
        Index("ix_delivery_key_time", "api_key_id", "created_at"),
    )


class ComplianceReceipt(Base):
    """Signed, exportable evidence of what was screened for one operation.

    This is the artifact a compliance officer needs in order to approve the integration at all: it
    proves an address was screened, against which list version, under which ASP root and enclave
    measurement — WITHOUT revealing amounts or counterparties. The signature is over a canonical
    JSON serialization so a third party can verify it offline, after export, years later.
    """
    __tablename__ = "compliance_receipts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    api_key_id: Mapped[str] = mapped_column(String, ForeignKey("api_keys.id"), nullable=False)
    operation_id: Mapped[str | None] = mapped_column(String, ForeignKey("operations.id"))
    subject_address: Mapped[str] = mapped_column(String, nullable=False)
    chain_id: Mapped[int | None] = mapped_column(Integer)
    result: Mapped[str] = mapped_column(String, nullable=False)  # pass|deny
    list_version: Mapped[str | None] = mapped_column(String)
    asp_root: Mapped[str | None] = mapped_column(String)
    attestation_digest: Mapped[str | None] = mapped_column(String)
    policy_version: Mapped[int | None] = mapped_column(Integer)
    payload: Mapped[dict | None] = mapped_column(JSONType)
    signature: Mapped[str] = mapped_column(Text, nullable=False)
    key_id: Mapped[str] = mapped_column(String, nullable=False)  # which signing key produced it
    screened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (
        Index("ix_receipt_key_time", "api_key_id", "created_at"),
        Index("ix_receipt_operation", "operation_id"),
    )


class Policy(Base):
    """A versioned, server-enforced control set for one API key.

    Enterprises must be able to DEMONSTRATE controls, not merely have them. Each PUT supersedes the
    previous version rather than mutating it, so an auditor can ask "what rules were in force when
    this operation ran?" and get an answer — operations record the policy_version they were
    evaluated under.
    """
    __tablename__ = "policies"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    api_key_id: Mapped[str] = mapped_column(String, ForeignKey("api_keys.id"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    rules: Mapped[dict | None] = mapped_column(JSONType)
    status: Mapped[str] = mapped_column(String, nullable=False, default="active")  # active|superseded
    created_by: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("api_key_id", "version", name="uq_policy_version"),
        Index("ix_policy_active", "api_key_id", "status"),
    )


class ManagedAccount(Base):
    """A business-scoped shielded-account registration.

    New accounts are `self_custody`: the associated wallet controls every note and authorizes every
    fund-moving request. Legacy `enclave_custody` rows remain readable during migration, but that
    mode is never selected implicitly by the public API.

    `keeper_ref` is the derivation reference handed to the keeper and is deliberately NAMESPACED BY
    API KEY (`{api_key_id}:{external_ref}`). If it were the caller's `external_ref` alone, two
    integrators who both name an account "customer-1" would derive byte-identical notes and could
    spend each other's funds. The namespacing is the isolation boundary.

    `next_note_index` is allocated under a row lock; the keeper derivation is deterministic on
    index, so handing the same index to two concurrent deposits would mint the same commitment
    twice — one of which could never be spent.
    """
    __tablename__ = "managed_accounts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    api_key_id: Mapped[str] = mapped_column(String, ForeignKey("api_keys.id"), nullable=False)
    subaccount_id: Mapped[str | None] = mapped_column(String, ForeignKey("subaccounts.id"))
    external_ref: Mapped[str] = mapped_column(String, nullable=False)
    keeper_ref: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    fingerprint: Mapped[str] = mapped_column(String, nullable=False)
    # EVM address derived in the enclave from the same seed. Public by nature: it is a payout
    # destination and the `DepositInfo.depositor` that holds ragequit authority. Per-account rather
    # than one shared integrator treasury, so a platform cannot unilaterally exit a customer's note.
    owner_address: Mapped[str | None] = mapped_column(String)
    control_mode: Mapped[str] = mapped_column(String, nullable=False, default="enclave_custody")
    status: Mapped[str] = mapped_column(String, nullable=False, default="active")
    next_note_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    label: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("api_key_id", "external_ref", name="uq_managed_account_external"),
        CheckConstraint(
            "control_mode IN ('self_custody', 'enclave_custody')",
            name="ck_managed_account_control_mode",
        ),
        Index("ix_managed_account_key", "api_key_id", "status"),
    )


class ManagedNote(Base):
    """The PUBLIC half of one managed note.

    Deliberately carries no `nullifier` or `secret` — those exist only inside the keeper and are
    re-derivable from (master key, keeper_ref, index). That is the point: this table can be dumped,
    logged, backed up or leaked without exposing anything spendable, and losing it entirely is an
    availability problem rather than a loss of funds.
    """
    __tablename__ = "managed_notes"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uid)
    account_id: Mapped[str] = mapped_column(String, ForeignKey("managed_accounts.id"), nullable=False)
    api_key_id: Mapped[str] = mapped_column(String, ForeignKey("api_keys.id"), nullable=False)
    operation_id: Mapped[str | None] = mapped_column(String, ForeignKey("operations.id"))
    note_index: Mapped[int] = mapped_column(Integer, nullable=False)
    chain_id: Mapped[int] = mapped_column(Integer, nullable=False)
    asset: Mapped[str] = mapped_column(String, nullable=False)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    label: Mapped[str] = mapped_column(String, nullable=False)
    precommitment: Mapped[str] = mapped_column(String, nullable=False)
    commitment: Mapped[str] = mapped_column(String, nullable=False)
    nullifier_hash: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")  # pending|confirmed|spent
    tx_hash: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("account_id", "note_index", name="uq_managed_note_index"),
        Index("ix_managed_note_account", "account_id", "status"),
        Index("ix_managed_note_commitment", "commitment"),
    )


class TxBinding(Base):
    """Binds an on-chain tx_hash to the (wallet, api_key_id) that created it, so a `…/confirmation`
    can verify the caller owns the tx before metering/mutating (BOLA) — via an INDEXED tx_hash
    lookup, never a table scan. Kept separate from `idempotency_keys` (different concern) and never
    serialized to the client (the internal api_key_id must not leak into a response body)."""
    __tablename__ = "tx_bindings"

    tx_hash: Mapped[str] = mapped_column(String, primary_key=True)  # PK -> indexed, unique lookup
    wallet: Mapped[str] = mapped_column(String, nullable=False)
    api_key_id: Mapped[str] = mapped_column(String, nullable=False)
    chain_id: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)  # withdrawal | consolidation
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
