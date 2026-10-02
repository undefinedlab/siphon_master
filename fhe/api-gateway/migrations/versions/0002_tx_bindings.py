"""tx_bindings: bind on-chain tx_hash -> (wallet, api_key_id) for confirmation ownership checks

Revision ID: 0002_tx_bindings
Revises: 0001_gateway_tables
Create Date: 2026-07-21

Add-only, reversible. The tx_hash PK gives an indexed, unique lookup so a `…/confirmation` verifies
the caller owns the tx without scanning the idempotency table.
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_tx_bindings"
down_revision = "0001_gateway_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tx_bindings",
        sa.Column("tx_hash", sa.String(), primary_key=True),
        sa.Column("wallet", sa.String(), nullable=False),
        sa.Column("api_key_id", sa.String(), nullable=False),
        sa.Column("chain_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("tx_bindings")
