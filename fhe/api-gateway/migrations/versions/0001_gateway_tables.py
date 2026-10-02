"""gateway tables: api_keys, usage_events, idempotency_keys, audit_log

Revision ID: 0001_gateway_tables
Revises:
Create Date: 2026-07-21

Add-only, reversible (spec §8): creates the four gateway tables. Money is BIGINT minor units,
timestamps TIMESTAMPTZ, constraints declared explicitly. `audit_log.detail` (JSONB) carries
credit-grant context (§5.4). `usage_events` UNIQUE(event_type, tx_hash) dedupes execution metering.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001_gateway_tables"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "api_keys",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("key_hash", sa.Text(), nullable=False),
        sa.Column("integrator_id", sa.String(), nullable=False),
        sa.Column("plan", sa.String(), nullable=False),
        sa.Column("balance_minor", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("key_hash", name="uq_apikey_key_hash"),
        sa.CheckConstraint("balance_minor >= 0", name="ck_apikey_balance_nonneg"),
    )
    op.create_index("ix_apikey_integrator", "api_keys", ["integrator_id"])
    op.create_index("ix_apikey_status", "api_keys", ["status"])

    op.create_table(
        "usage_events",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("api_key_id", sa.String(), sa.ForeignKey("api_keys.id"), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("strategy_id", sa.String(), nullable=True),
        sa.Column("tx_hash", sa.String(), nullable=True),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("request_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("event_type", "tx_hash", name="uq_usage_event_txhash"),
    )
    op.create_index("ix_usage_key_time", "usage_events", ["api_key_id", "created_at"])
    op.create_index("ix_usage_type", "usage_events", ["event_type"])

    op.create_table(
        "idempotency_keys",
        sa.Column("key", sa.String(), primary_key=True),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("response_body", postgresql.JSONB(), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="in_progress"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "audit_log",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("actor", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("target", sa.String(), nullable=True),
        sa.Column("detail", postgresql.JSONB(), nullable=True),
        sa.Column("request_id", sa.String(), nullable=False),
        sa.Column("result", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("audit_log")
    op.drop_table("idempotency_keys")
    op.drop_index("ix_usage_type", table_name="usage_events")
    op.drop_index("ix_usage_key_time", table_name="usage_events")
    op.drop_table("usage_events")
    op.drop_index("ix_apikey_status", table_name="api_keys")
    op.drop_index("ix_apikey_integrator", table_name="api_keys")
    op.drop_table("api_keys")
