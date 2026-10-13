use ark_bn254::Fr;
use ark_ff::PrimeField;
use light_poseidon::{Poseidon, PoseidonHasher};
use num_bigint::BigUint;
use thiserror::Error;

use crate::constants::SMT_DEPTH;

#[derive(Debug, Error)]
pub enum PoseidonError {
    #[error("poseidon hash failed: {0}")]
    Hash(String),
}

pub type Field = Fr;

pub fn field_from_str(s: &str) -> Field {
    let n = BigUint::parse_bytes(s.as_bytes(), 10).expect("valid decimal field");
    Fr::from(n)
}

pub fn field_to_str(f: &Field) -> String {
    use ark_ff::BigInteger;
    f.into_bigint().to_string()
}

fn poseidon(inputs: &[Field]) -> Result<Field, PoseidonError> {
    let mut h = Poseidon::<Fr>::new_circom(inputs.len())
        .map_err(|e| PoseidonError::Hash(e.to_string()))?;
    h.hash(inputs)
        .map_err(|e| PoseidonError::Hash(e.to_string()))
}

pub fn hash1(a: Field) -> Result<Field, PoseidonError> {
    poseidon(&[a])
}

pub fn hash2(a: Field, b: Field) -> Result<Field, PoseidonError> {
    poseidon(&[a, b])
}

pub fn hash3(a: Field, b: Field, c: Field) -> Result<Field, PoseidonError> {
    poseidon(&[a, b, c])
}

/// `smtKey(label) = Poseidon(DOMAIN_SMT_KEY, label)` — PROTOCOL §2.5
pub fn smt_key_domain(label: Field, domain_smt_key: Field) -> Result<Field, PoseidonError> {
    hash2(domain_smt_key, label)
}

/// Occupied revocation leaf — PROTOCOL §2.5
pub fn leaf_hash_domain(label: Field, domain_smt_leaf: Field) -> Result<Field, PoseidonError> {
    hash2(domain_smt_leaf, label)
}

/// Build `EMPTY_SUBTREE[d]` bottom-up; index 0 is `EMPTY_LEAF`.
pub fn build_empty_subtrees(empty_leaf: Field) -> Result<Vec<Field>, PoseidonError> {
    let mut subtrees = vec![empty_leaf; SMT_DEPTH + 1];
    for d in 0..SMT_DEPTH {
        subtrees[d + 1] = hash2(subtrees[d], subtrees[d])?;
    }
    Ok(subtrees)
}
