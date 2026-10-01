//! Payee encoding for the normative `solana-v1` chain profile.

use siphon_kernel_types::KernelError;

use crate::poseidon::{
    field_from_be_bytes, field_from_le_bytes, field_from_u64, field_to_le_bytes, hash2,
    DOMAIN_PAYEE, DOMAIN_PAYEE_SOL_COMPRESS,
};

pub trait PayeeCodec {
    /// Compress raw chain payee to a 32-byte field element (`payeeField`).
    fn payee_field(&self, raw_payee: &[u8; 32]) -> Result<[u8; 32], KernelError>;

    /// Public identity bound by WITHDRAW and RAGEQUIT.
    fn payee_id(&self, raw_payee: &[u8; 32]) -> Result<[u8; 32], KernelError>;
}

/// `payeeField = Poseidon(7, pubkeyField)`, then `payeeId = Poseidon(4, payeeField)`.
#[derive(Default, Debug)]
pub struct SolanaPayeeCodec;

impl PayeeCodec for SolanaPayeeCodec {
    fn payee_field(&self, raw_payee: &[u8; 32]) -> Result<[u8; 32], KernelError> {
        let field = hash2(
            field_from_u64(DOMAIN_PAYEE_SOL_COMPRESS),
            field_from_be_bytes(raw_payee),
        )?;
        Ok(field_to_le_bytes(&field))
    }

    fn payee_id(&self, raw_payee: &[u8; 32]) -> Result<[u8; 32], KernelError> {
        let payee_field = self.payee_field(raw_payee)?;
        let id = hash2(
            field_from_u64(DOMAIN_PAYEE),
            field_from_le_bytes(&payee_field),
        )?;
        Ok(field_to_le_bytes(&id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poseidon::{field_to_le_bytes, vault_scope_id};
    use ark_bn254::Fr;
    use num_bigint::BigUint;

    fn decimal_field_bytes(value: &str) -> [u8; 32] {
        field_to_le_bytes(&Fr::from(
            BigUint::parse_bytes(value.as_bytes(), 10).unwrap(),
        ))
    }

    #[test]
    fn matches_frozen_solana_profile_vectors() {
        let program_id = [0x11; 32];
        let vault_pda = [0x22; 32];
        let payee = [0x33; 32];

        assert_eq!(
            vault_scope_id(&program_id, &vault_pda).unwrap(),
            decimal_field_bytes(
                "19183590508245192203012639644333567682872289463675851048584515047362978462210"
            )
        );
        assert_eq!(
            SolanaPayeeCodec.payee_id(&payee).unwrap(),
            decimal_field_bytes(
                "16251131778136927336947831390974037088188521032891601592675718001963620016178"
            )
        );
    }
}
