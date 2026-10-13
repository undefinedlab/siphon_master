//! Deposit guest public outputs — PROTOCOL.md §2.7 (separate from 25-limb spend).

use crate::constants::PROGRAM_VERSION;
use crate::poseidon::Field;

pub const DEPOSIT_PUBLIC_WIDTH: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepositOutputs {
    pub measured_amount: Field,
    pub commitment: Field,
    pub deposit_nonce: u64,
    pub vault_scope_id: Field,
    pub program_version: u32,
}

impl DepositOutputs {
    pub fn to_limbs(&self) -> [Field; DEPOSIT_PUBLIC_WIDTH] {
        [
            self.measured_amount,
            self.commitment,
            Field::from(self.deposit_nonce),
            self.vault_scope_id,
            Field::from(PROGRAM_VERSION as u64),
        ]
    }

    pub fn limb_strings(&self) -> Vec<String> {
        self.to_limbs()
            .iter()
            .map(crate::poseidon::field_to_str)
            .collect()
    }
}
