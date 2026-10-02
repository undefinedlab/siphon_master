"""Mark account control mode so the API can default safely to self-custody.

Revision ID: 0006_self_custody_accounts
Revises: 0005_managed_accounts
Create Date: 2026-08-25
"""
from alembic import op
import sqlalchemy as sa

revision = "0006_self_custody_accounts"
down_revision = "0005_managed_accounts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Existing rows were created by the enclave keeper and must not be silently reclassified.
    op.add_column(
        "managed_accounts",
        sa.Column(
            "control_mode", sa.String(), nullable=False, server_default="enclave_custody"
        ),
    )
    op.create_check_constraint(
        "ck_managed_account_control_mode",
        "managed_accounts",
        "control_mode IN ('self_custody', 'enclave_custody')",
    )
    op.add_column(
        "operations", sa.Column("last_chain_check_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_index(
        "ix_operation_chain_check", "operations", ["state", "last_chain_check_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_operation_chain_check", table_name="operations")
    op.drop_column("operations", "last_chain_check_at")
    op.drop_constraint(
        "ck_managed_account_control_mode", "managed_accounts", type_="check"
    )
    op.drop_column("managed_accounts", "control_mode")
