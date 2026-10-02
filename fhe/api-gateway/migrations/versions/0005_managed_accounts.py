"""managed_accounts + managed_notes: enclave-custodied shielded accounts

Revision ID: 0005_managed_accounts
Revises: 0004_platform_surface
Create Date: 2026-08-20

Add-only, reversible.

`managed_notes` holds ONLY public values — precommitment, commitment, nullifier_hash. No nullifier,
no secret: those exist solely inside the shielded keeper and are re-derivable from
(master key, keeper_ref, index). This table can be dumped, replicated or leaked without exposing
anything spendable.

Two uniqueness constraints carry real weight:

* `managed_accounts.keeper_ref` UNIQUE — the derivation reference is `{api_key_id}:{external_ref}`,
  so a collision would mean two accounts deriving identical notes.
* `uq_managed_note_index (account_id, note_index)` — keeper derivation is deterministic on index, so
  reusing an index mints the same commitment twice. The service takes a row lock; this is the
  database-level backstop for when that lock is bypassed or a retry races.
"""
from alembic import op
import sqlalchemy as sa

revision = "0005_managed_accounts"
down_revision = "0004_platform_surface"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "managed_accounts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("api_key_id", sa.String(), sa.ForeignKey("api_keys.id"), nullable=False),
        sa.Column("subaccount_id", sa.String(), sa.ForeignKey("subaccounts.id"), nullable=True),
        sa.Column("external_ref", sa.String(), nullable=False),
        sa.Column("keeper_ref", sa.String(), nullable=False, unique=True),
        sa.Column("fingerprint", sa.String(), nullable=False),
        sa.Column("owner_address", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column("next_note_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("api_key_id", "external_ref", name="uq_managed_account_external"),
    )
    op.create_index("ix_managed_account_key", "managed_accounts", ["api_key_id", "status"])

    op.create_table(
        "managed_notes",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("account_id", sa.String(), sa.ForeignKey("managed_accounts.id"), nullable=False),
        sa.Column("api_key_id", sa.String(), sa.ForeignKey("api_keys.id"), nullable=False),
        sa.Column("operation_id", sa.String(), sa.ForeignKey("operations.id"), nullable=True),
        sa.Column("note_index", sa.Integer(), nullable=False),
        sa.Column("chain_id", sa.Integer(), nullable=False),
        sa.Column("asset", sa.String(), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("precommitment", sa.String(), nullable=False),
        sa.Column("commitment", sa.String(), nullable=False),
        sa.Column("nullifier_hash", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("tx_hash", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("account_id", "note_index", name="uq_managed_note_index"),
    )
    op.create_index("ix_managed_note_account", "managed_notes", ["account_id", "status"])
    op.create_index("ix_managed_note_commitment", "managed_notes", ["commitment"])


def downgrade() -> None:
    op.drop_index("ix_managed_note_commitment", table_name="managed_notes")
    op.drop_index("ix_managed_note_account", table_name="managed_notes")
    op.drop_table("managed_notes")
    op.drop_index("ix_managed_account_key", table_name="managed_accounts")
    op.drop_table("managed_accounts")
