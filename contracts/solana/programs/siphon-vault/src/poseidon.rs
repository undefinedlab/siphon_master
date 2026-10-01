//! Circom-compatible BN254 Poseidon helpers shared by the host rails.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use light_poseidon::{Poseidon, PoseidonHasher};
use num_bigint::BigUint;
use siphon_kernel_types::KernelError;

pub type Field = Fr;

pub const DOMAIN_VAULT_SCOPE: u64 = 3;
pub const DOMAIN_PAYEE: u64 = 4;
pub const DOMAIN_CHAIN_SOL: u64 = 6;
pub const DOMAIN_PAYEE_SOL_COMPRESS: u64 = 7;

fn hash(inputs: &[Field]) -> Result<Field, KernelError> {
    let mut poseidon =
        Poseidon::<Fr>::new_circom(inputs.len()).map_err(|_| KernelError::PoseidonHashFailed)?;
    poseidon
        .hash(inputs)
        .map_err(|_| KernelError::PoseidonHashFailed)
}

pub fn hash2(a: Field, b: Field) -> Result<Field, KernelError> {
    hash(&[a, b])
}

pub fn hash3(a: Field, b: Field, c: Field) -> Result<Field, KernelError> {
    hash(&[a, b, c])
}

/// Interprets an external byte string as an unsigned big-endian integer reduced modulo Fr.
pub fn field_from_be_bytes(bytes: &[u8]) -> Field {
    Fr::from(BigUint::from_bytes_be(bytes))
}

/// Canonical 32-byte big-endian field encoding.
pub fn field_to_be_bytes(field: &Field) -> [u8; 32] {
    let encoded = field.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - encoded.len()..].copy_from_slice(&encoded);
    out
}

/// Canonical 32-byte little-endian limb encoding used by `PublicInputs`.
pub fn field_from_le_bytes(bytes: &[u8; 32]) -> Field {
    let mut be = *bytes;
    be.reverse();
    field_from_be_bytes(&be)
}

pub fn field_to_le_bytes(field: &Field) -> [u8; 32] {
    let mut out = field_to_be_bytes(field);
    out.reverse();
    out
}

pub fn field_from_u64(value: u64) -> Field {
    Field::from(value)
}

pub fn vault_scope_id(
    program_id: &[u8; 32],
    vault_pda: &[u8; 32],
) -> Result<[u8; 32], KernelError> {
    let scope = hash3(
        field_from_u64(DOMAIN_CHAIN_SOL),
        field_from_be_bytes(program_id),
        field_from_be_bytes(vault_pda),
    )?;
    Ok(field_to_le_bytes(&scope))
}
