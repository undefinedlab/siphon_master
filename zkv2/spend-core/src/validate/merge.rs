//! MERGE action — PROTOCOL.md §6.2

use crate::commitment::commitment;
use crate::constants::MAX_INPUTS;
use crate::poseidon::{field_from_str, Field};
use crate::public::PublicOutputs;
use crate::smt::load_domains;
use crate::witness::SpendWitness;

use super::common::{sum_values, validate_private_inputs};
use super::ValidateError;

pub fn validate_merge(w: &SpendWitness) -> Result<PublicOutputs, ValidateError> {
    if w.input_count < 2 || w.input_count as usize > MAX_INPUTS {
        return Err(ValidateError::InvalidInputCount);
    }
    if w.boundary_index >= w.input_count {
        return Err(ValidateError::InvalidBoundaryIndex);
    }

    let n = w.input_count as usize;
    let k = w.boundary_index as usize;

    let state_root = field_from_str(&w.state_root);
    let admitted_root = field_from_str(&w.admitted_root);
    let revoked_root = field_from_str(&w.revoked_root);
    let primary = field_from_str(&w.primary_value);
    let secondary = field_from_str(&w.secondary_value);
    let out_nullifier = field_from_str(&w.out_nullifier);
    let out_secret = field_from_str(&w.out_secret);

    let (domain_key, _) = load_domains();
    let validated = validate_private_inputs(
        &w.inputs,
        n,
        state_root,
        admitted_root,
        revoked_root,
        domain_key,
        out_nullifier,
    )?;

    let sum = sum_values(&validated.values, n);
    if primary != sum && primary != Field::from(0u64) {
        return Err(ValidateError::MergePrimaryMismatch);
    }
    if secondary != Field::from(0u64) {
        return Err(ValidateError::MergeSecondaryNonZero);
    }

    let boundary_value = validated.values[k];
    for i in 0..n {
        if validated.values[i] > boundary_value {
            return Err(ValidateError::MergeBoundaryNotMax(i));
        }
    }

    let out_label = validated.labels[k];
    let asset_id = validated.asset_ids[0];
    // Amount is bound in the commitment only — public limb 5 MUST be 0 (PROTOCOL 3.4.1).
    let out_commitment = commitment(sum, out_label, asset_id, out_nullifier, out_secret)?;

    Ok(PublicOutputs {
        action: w.action,
        input_count: w.input_count,
        state_root,
        admitted_root,
        revoked_root,
        primary_value: Field::from(0u64),
        secondary_value: Field::from(0u64),
        out_commitment,
        out_label: Field::from(0u64),
        nullifier_hashes: validated.nullifier_hashes,
        payee_id: Field::from(0u64),
        program_version: crate::constants::PROGRAM_VERSION,
        mux: [Field::from(0u64); 8],
    })
}
