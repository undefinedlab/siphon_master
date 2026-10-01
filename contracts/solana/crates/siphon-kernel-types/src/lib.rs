//! Chain-agnostic Siphon kernel types.
//!
//! Shared by Solana (`solana-v1`) and any future runtime. Limb layout matches
//! `siphon-zk-v2` / `spec/public-inputs.md`. No chain SDK dependencies.

#![forbid(unsafe_code)]

mod action;
mod checklist;
mod error;
mod public_inputs;

pub use action::SpendAction;
pub use checklist::{KernelChecklist, SpendPhase};
pub use error::KernelError;
pub use public_inputs::{
    PublicInputs, ACTION_LIMB, GROTH16_PROOF_BYTES, INPUT_COUNT_LIMB, MAX_INPUTS, NULLIFIER_START,
    OUT_LABEL_LIMB, PROGRAM_VERSION_LIMB, PUBLIC_WIDTH,
};

/// Profile ids as used in `PROGRAM_VERSION` tuples (documentation / routing).
pub mod profile_id {
    pub const EVM_V1: &str = "evm-v1";
    pub const SOLANA_V1: &str = "solana-v1";
}

/// Verify artifact id pinned for solana-v1 (see VERIFY-RESEARCH.md).
pub mod verify_artifact_id {
    pub const GROTH16_BN254_SOLANA_ALTBN128_V1: &str = "groth16-bn254-solana-altbn128-v1";
}
