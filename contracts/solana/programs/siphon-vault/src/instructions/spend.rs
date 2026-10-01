//! Spend — kernel checklist then action dispatch.

use siphon_kernel_types::{PublicInputs, PUBLIC_WIDTH};

/// Relayer-callable spend. `raw_payee` is a 32-byte Solana pubkey for withdraw/ragequit/swap bind.
/// Public inputs are expected in the pending-inputs PDA (not inline) for tx-size reasons.
#[derive(Clone, Debug)]
pub struct SpendArgs {
    /// Opaque proof bytes — 256-byte A||B||C for alt_bn128 artifact.
    pub proof: Vec<u8>,
    pub raw_payee: [u8; 32],
    /// SPLIT only — up to 8 output commitments (unused slots zero).
    pub split_commitments: [[u8; 32]; 8],
}

impl SpendArgs {
    pub fn public_width() -> usize {
        PUBLIC_WIDTH
    }
}

/// Tx1: commit publics before spend.
#[derive(Clone, Debug)]
pub struct CommitPublicInputsArgs {
    pub binder: [u8; 32],
    pub public_inputs: PublicInputs,
}
