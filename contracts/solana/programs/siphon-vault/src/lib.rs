//! Siphon Solana vault (`solana-v1`).
//!
//! Modular ports mirror `spec/runtime-modules.md`.
//! Verify artifact: `groth16-bn254-solana-altbn128-v1` (see VERIFY-RESEARCH.md).

#![forbid(unsafe_code)]

pub mod adapters;
pub mod anchor_api;
pub mod deposit_flow;
pub mod instructions;
pub mod note_tree;
pub mod nullifiers;
pub mod pending_inputs;
pub mod poseidon;
pub mod profile;
pub mod spend_flow;
pub mod state;
pub mod verify;

pub use siphon_kernel_types as kernel;

/// Program identity string for docs / PDA seeds (replace with Keypair pubkey at deploy).
pub const PROGRAM_SEED: &[u8] = b"siphon-vault-v1";

/// Compliance PDA seed.
pub const COMPLIANCE_SEED: &[u8] = b"siphon-compliance-v1";

/// Pending public-inputs PDA seed prefix.
pub const PENDING_INPUTS_SEED: &[u8] = b"siphon-pending-inputs-v1";
