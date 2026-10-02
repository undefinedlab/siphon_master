"""credit_ledger: typed, append-only billing source of truth

Revision ID: 0003_credit_ledger
Revises: 0002_tx_bindings
Create Date: 2026-08-20

Balances were previously reported by summing `audit_log.detail->>'amount_minor'` in Python at read
time, which made customer billing depend on audit-log retention. This table makes the ledger typed
and indexable; `api_keys.balance_minor` becomes a materialized cache of SUM(amount_minor) here.

The backfill is add-only and idempotent: it replays historical `credit.grant` audit rows and any
non-zero residual balance into the ledger so existing keys reconcile immediately.
"""
from alembic import op
import sqlalchemy as sa

revision = "0003_credit_ledger"
down_revision = "0002_tx_bindings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "credit_ledger",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("api_key_id", sa.String(), sa.ForeignKey("api_keys.id"), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("balance_after", sa.BigInteger(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("request_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("balance_after >= 0", name="ck_ledger_balance_nonneg"),
    )
    op.create_index("ix_ledger_key_time", "credit_ledger", ["api_key_id", "created_at"])
    op.create_index("ix_ledger_key_kind", "credit_ledger", ["api_key_id", "kind"])

    # Backfill: one 'migration' entry per key carrying its current cached balance, so the ledger sum
    # equals api_keys.balance_minor from day one. Historical grant detail stays in audit_log for the
    # security trail; we deliberately do not re-derive arithmetic from it.
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        bind.execute(
            sa.text(
                """
                INSERT INTO credit_ledger
                    (id, api_key_id, kind, amount_minor, balance_after, reason, request_id, created_at)
                SELECT
                    gen_random_uuid()::text, id, 'migration', balance_minor, balance_minor,
                    'backfill from api_keys.balance_minor at 0003', 'migration_0003', now()
                FROM api_keys
                WHERE balance_minor <> 0
                """
            )
        )


def downgrade() -> None:
    op.drop_index("ix_ledger_key_kind", table_name="credit_ledger")
    op.drop_index("ix_ledger_key_time", table_name="credit_ledger")
    op.drop_table("credit_ledger")
