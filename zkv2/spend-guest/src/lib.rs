//! Universal spend guest — PROTOCOL.md §4.6.
//!
//! Native feature runs `spend-core::validate_witness` and returns the 25 canonical
//! public limbs for CI / `siphon-prove`. Product proofs are Circom Groth16
//! (`circuits/`), not a zkVM journal.

mod deposit_journal;
mod deposit_native;
mod journal;
mod native;

pub use deposit_journal::{DepositCommittedPublics, DepositGuestError, DepositGuestOutput};
pub use deposit_native::run_native_deposit_guest;
pub use journal::{CommittedPublics, GuestError, GuestOutput};
pub use native::run_native_guest;

/// Guest logic id — must match [`manifest/universal-spend-v1.json`].
pub const GUEST_LOGIC_ID: &str = "universal-spend-v1";
pub const DEPOSIT_GUEST_LOGIC_ID: &str = "deposit-bind-v1";

/// Run guest for witness JSON string (native simulation).
pub fn run_guest_json(witness_json: &str) -> Result<GuestOutput, GuestError> {
    run_native_guest(witness_json)
}

/// Run deposit guest for witness JSON string (native simulation).
pub fn run_deposit_guest_json(witness_json: &str) -> Result<DepositGuestOutput, DepositGuestError> {
    run_native_deposit_guest(witness_json)
}
