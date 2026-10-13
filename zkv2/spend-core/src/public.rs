//! Canonical 25-limb public encoding — PROTOCOL.md §4.

use crate::constants::{PROGRAM_VERSION, PUBLIC_WIDTH};
use crate::poseidon::Field;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicOutputs {
    pub action: u8,
    pub input_count: u8,
    pub state_root: Field,
    pub admitted_root: Field,
    pub revoked_root: Field,
    pub primary_value: Field,
    pub secondary_value: Field,
    pub out_commitment: Field,
    pub out_label: Field,
    pub nullifier_hashes: [Field; 6],
    pub payee_id: Field,
    pub program_version: u32,
    pub mux: [Field; 8],
}

impl PublicOutputs {
    pub fn to_bn254_limbs(&self) -> [Field; PUBLIC_WIDTH] {
        let mut out = [Field::from(0u64); PUBLIC_WIDTH];
        out[0] = Field::from(self.action as u64);
        out[1] = Field::from(self.input_count as u64);
        out[2] = self.state_root;
        out[3] = self.admitted_root;
        out[4] = self.revoked_root;
        out[5] = self.primary_value;
        out[6] = self.secondary_value;
        out[7] = self.out_commitment;
        // PROTOCOL 3.4: limb 8 is always 0 (outLabel is not a join key).
        out[8] = Field::from(0u64);
        for (i, nh) in self.nullifier_hashes.iter().enumerate() {
            out[9 + i] = *nh;
        }
        out[15] = self.payee_id;
        out[16] = Field::from(PROGRAM_VERSION as u64);
        for (i, m) in self.mux.iter().enumerate() {
            out[17 + i] = *m;
        }
        out
    }

    pub fn limb_strings(&self) -> Vec<String> {
        self.to_bn254_limbs()
            .iter()
            .map(crate::poseidon::field_to_str)
            .collect()
    }
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    use crate::constants::{MAX_INPUTS, PROGRAM_VERSION, PUBLIC_WIDTH};

    /// GF-M2: shared 25-limb layout must stay pinned (Solidity PublicInputs.WIDTH).
    #[test]
    fn public_width_is_twenty_five() {
        assert_eq!(PUBLIC_WIDTH, 25);
        let empty = PublicOutputs {
            action: 0,
            input_count: 1,
            state_root: Field::from(0u64),
            admitted_root: Field::from(0u64),
            revoked_root: Field::from(0u64),
            primary_value: Field::from(0u64),
            secondary_value: Field::from(0u64),
            out_commitment: Field::from(0u64),
            out_label: Field::from(99u64), // ignored — limb 8 forced to 0
            nullifier_hashes: [Field::from(0u64); 6],
            payee_id: Field::from(0u64),
            program_version: PROGRAM_VERSION,
            mux: [Field::from(0u64); 8],
        };
        let limbs = empty.to_bn254_limbs();
        assert_eq!(limbs.len(), 25);
        assert_eq!(limbs[8], Field::from(0u64));
        assert_eq!(limbs[16], Field::from(PROGRAM_VERSION as u64));
    }

    #[test]
    fn action_bounds_match_solidity() {
        // 0..4 inclusive — mirrors PublicInputs.ACTION_* / SpendAction::from_u8
        for a in 0u8..=4 {
            assert!(crate::validate::SpendAction::from_u8(a).is_some());
        }
        assert!(crate::validate::SpendAction::from_u8(5).is_none());
        assert_eq!(MAX_INPUTS, 6);
    }
}
