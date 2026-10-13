use crate::poseidon::{hash2, hash3, Field, PoseidonError};

pub fn precommitment(nullifier: Field, secret: Field) -> Result<Field, PoseidonError> {
    hash2(nullifier, secret)
}

pub fn nullifier_hash(nullifier: Field) -> Result<Field, PoseidonError> {
    crate::poseidon::hash1(nullifier)
}

/// Matches `CommitmentLib` / circom `commitment.circom` (D1, PROGRAM_VERSION ≥ 3 — unchanged in v4).
pub fn commitment(
    amount: Field,
    label: Field,
    asset_id: Field,
    nullifier: Field,
    secret: Field,
) -> Result<Field, PoseidonError> {
    let pre = precommitment(nullifier, secret)?;
    commitment_with_pre(amount, label, asset_id, pre)
}

/// Swap destination leaf — PROTOCOL §6.3 (`outputPrecommitment` is public mux 21).
pub fn commitment_with_pre(
    amount: Field,
    label: Field,
    asset_id: Field,
    precommitment: Field,
) -> Result<Field, PoseidonError> {
    let inner = hash3(amount, label, asset_id)?;
    hash2(inner, precommitment)
}
