//! Instruction surface — same logical ops as EVM `deposit` / `spend`.

mod deposit;
mod spend;

pub use deposit::DepositArgs;
pub use spend::{CommitPublicInputsArgs, SpendArgs};

use siphon_kernel_types::SpendAction;

/// Top-level instruction enum (Anchor `#[instruction]` / borsh later).
#[allow(clippy::large_enum_variant)] // IDL wire shape is fixed-width; do not encode heap pointers.
#[derive(Clone, Debug)]
pub enum VaultInstruction {
    /// Initialize vault PDA + pin program_version / vault_scope_id.
    InitializeVault {
        vault_scope_id: [u8; 32],
        program_version: [u8; 32],
    },
    /// Initialize or rotate compliance roots account.
    SetComplianceRoots {
        admitted_root: [u8; 32],
        revoked_root: [u8; 32],
    },
    /// Tx1 — write 25 public limbs into pending-inputs PDA.
    CommitPublicInputs(CommitPublicInputsArgs),
    Deposit(DepositArgs),
    /// Tx2 — verify proof against pending publics, burn nullifiers, dispatch.
    Spend(SpendArgs),
    PauseDeposits {
        paused: bool,
    },
    PauseAction {
        action: SpendAction,
        paused: bool,
    },
}
