"""platform surface: subaccounts, operations, batches, webhooks, compliance receipts, policies

Revision ID: 0004_platform_surface
Revises: 0003_credit_ledger
Create Date: 2026-08-20

Add-only and reversible. Also adds `credit_ledger.subaccount_id` (nullable), which is what makes
per-tenant spend caps derivable from the existing ledger rather than from a drift-prone counter.

Table order matters: subaccounts and batches are created before operations, and operations before
webhook_deliveries / compliance_receipts, because of the FKs between them.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0004_platform_surface"
down_revision = "0003_credit_ledger"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "subaccounts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("api_key_id", sa.String(), sa.ForeignKey("api_keys.id"), nullable=False),
        sa.Column("external_id", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column("spend_cap_minor", sa.BigInteger(), nullable=True),
        sa.Column("rate_limit_per_min", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("api_key_id", "external_id", name="uq_subaccount_external"),
        sa.CheckConstraint("spend_cap_minor IS NULL OR spend_cap_minor >= 0", name="ck_subaccount_cap_nonneg"),
    )
    op.create_index("ix_subaccount_key", "subaccounts", ["api_key_id", "status"])

    op.create_table(
        "batches",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("api_key_id", sa.String(), sa.ForeignKey("api_keys.id"), nullable=False),
        sa.Column("subaccount_id", sa.String(), sa.ForeignKey("subaccounts.id"), nullable=True),
        sa.Column("kind", sa.String(), nullable=False, server_default="payout"),
        sa.Column("state", sa.String(), nullable=False, server_default="created"),
        sa.Column("chain_id", sa.Integer(), nullable=False),
        sa.Column("asset", sa.String(), nullable=False),
        sa.Column("item_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_amount_minor", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("wallet", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_batch_key_time", "batches", ["api_key_id", "created_at"])

    op.create_table(
        "operations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("api_key_id", sa.String(), sa.ForeignKey("api_keys.id"), nullable=False),
        sa.Column("subaccount_id", sa.String(), sa.ForeignKey("subaccounts.id"), nullable=True),
        sa.Column("batch_id", sa.String(), sa.ForeignKey("batches.id"), nullable=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("state", sa.String(), nullable=False, server_default="created"),
        sa.Column("chain_id", sa.Integer(), nullable=True),
        sa.Column("asset", sa.String(), nullable=True),
        sa.Column("amount_minor", sa.BigInteger(), nullable=True),
        sa.Column("recipient", sa.String(), nullable=True),
        sa.Column("tx_hash", sa.String(), nullable=True),
        sa.Column("wallet", sa.String(), nullable=True),
        sa.Column("error_code", sa.String(), nullable=True),
        sa.Column("detail", JSONB, nullable=True),
        sa.Column("retryable", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_operation_key_time", "operations", ["api_key_id", "created_at"])
    op.create_index("ix_operation_state", "operations", ["api_key_id", "state"])
    op.create_index("ix_operation_tx", "operations", ["tx_hash"])
    op.create_index("ix_operation_batch", "operations", ["batch_id"])
    op.create_index("ix_operation_subaccount", "operations", ["subaccount_id", "created_at"])

    op.create_table(
        "webhook_endpoints",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("api_key_id", sa.String(), sa.ForeignKey("api_keys.id"), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("secret", sa.Text(), nullable=False),
        sa.Column("events", JSONB, nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_webhook_key", "webhook_endpoints", ["api_key_id", "status"])

    op.create_table(
        "webhook_deliveries",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("endpoint_id", sa.String(), sa.ForeignKey("webhook_endpoints.id"), nullable=False),
        sa.Column("api_key_id", sa.String(), sa.ForeignKey("api_keys.id"), nullable=False),
        sa.Column("operation_id", sa.String(), sa.ForeignKey("operations.id"), nullable=True),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("payload", JSONB, nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("response_status", sa.Integer(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_delivery_pending", "webhook_deliveries", ["status", "next_attempt_at"])
    op.create_index("ix_delivery_key_time", "webhook_deliveries", ["api_key_id", "created_at"])

    op.create_table(
        "compliance_receipts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("api_key_id", sa.String(), sa.ForeignKey("api_keys.id"), nullable=False),
        sa.Column("operation_id", sa.String(), sa.ForeignKey("operations.id"), nullable=True),
        sa.Column("subject_address", sa.String(), nullable=False),
        sa.Column("chain_id", sa.Integer(), nullable=True),
        sa.Column("result", sa.String(), nullable=False),
        sa.Column("list_version", sa.String(), nullable=True),
        sa.Column("asp_root", sa.String(), nullable=True),
        sa.Column("attestation_digest", sa.String(), nullable=True),
        sa.Column("policy_version", sa.Integer(), nullable=True),
        sa.Column("payload", JSONB, nullable=True),
        sa.Column("signature", sa.Text(), nullable=False),
        sa.Column("key_id", sa.String(), nullable=False),
        sa.Column("screened_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_receipt_key_time", "compliance_receipts", ["api_key_id", "created_at"])
    op.create_index("ix_receipt_operation", "compliance_receipts", ["operation_id"])

    op.create_table(
        "policies",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("api_key_id", sa.String(), sa.ForeignKey("api_keys.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("rules", JSONB, nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column("created_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("api_key_id", "version", name="uq_policy_version"),
    )
    op.create_index("ix_policy_active", "policies", ["api_key_id", "status"])

    op.add_column("credit_ledger", sa.Column("subaccount_id", sa.String(), nullable=True))
    op.create_foreign_key(
        "fk_ledger_subaccount", "credit_ledger", "subaccounts", ["subaccount_id"], ["id"]
    )
    op.create_index("ix_ledger_subaccount", "credit_ledger", ["subaccount_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_ledger_subaccount", table_name="credit_ledger")
    op.drop_constraint("fk_ledger_subaccount", "credit_ledger", type_="foreignkey")
    op.drop_column("credit_ledger", "subaccount_id")

    for idx, table in (
        ("ix_policy_active", "policies"),
        ("ix_receipt_operation", "compliance_receipts"),
        ("ix_receipt_key_time", "compliance_receipts"),
        ("ix_delivery_key_time", "webhook_deliveries"),
        ("ix_delivery_pending", "webhook_deliveries"),
        ("ix_webhook_key", "webhook_endpoints"),
        ("ix_operation_subaccount", "operations"),
        ("ix_operation_batch", "operations"),
        ("ix_operation_tx", "operations"),
        ("ix_operation_state", "operations"),
        ("ix_operation_key_time", "operations"),
        ("ix_batch_key_time", "batches"),
        ("ix_subaccount_key", "subaccounts"),
    ):
        op.drop_index(idx, table_name=table)

    op.drop_table("policies")
    op.drop_table("compliance_receipts")
    op.drop_table("webhook_deliveries")
    op.drop_table("webhook_endpoints")
    op.drop_table("operations")
    op.drop_table("batches")
    op.drop_table("subaccounts")
