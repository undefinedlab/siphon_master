//! SPLIT action — PROTOCOL.md §6.4 / §4.4

use crate::constants::MAX_SPLIT_OUTPUTS;
use crate::poseidon::{field_from_str, Field};
use crate::public::PublicOutputs;
use crate::split::{slice_commitments, split_root};
use crate::smt::load_domains;
use crate::witness::SpendWitness;

use super::common::validate_private_inputs;
use super::ValidateError;

pub fn validate_split(w: &SpendWitness) -> Result<PublicOutputs, ValidateError> {
    if w.input_count != 1 {
        return Err(ValidateError::InvalidInputCount);
    }
    if w.boundary_index != 0 {
        return Err(ValidateError::InvalidBoundaryIndex);
    }
    if w.split_values.len() != MAX_SPLIT_OUTPUTS
        || w.split_nullifiers.len() != MAX_SPLIT_OUTPUTS
        || w.split_secrets.len() != MAX_SPLIT_OUTPUTS
    {
        return Err(ValidateError::SplitSliceCount);
    }

    let state_root = field_from_str(&w.state_root);
    let admitted_root = field_from_str(&w.admitted_root);
    let revoked_root = field_from_str(&w.revoked_root);
    let primary = field_from_str(&w.primary_value);
    let secondary = field_from_str(&w.secondary_value);
    let out_nullifier = field_from_str(&w.out_nullifier);

    if primary != Field::from(0u64) || secondary != Field::from(0u64) {
        return Err(ValidateError::SplitPublicValuesNonZero);
    }

    let (domain_key, _) = load_domains();
    let validated = validate_private_inputs(
        &w.inputs,
        1,
        state_root,
        admitted_root,
        revoked_root,
        domain_key,
        out_nullifier,
    )?;

    let in_value = validated.values[0];
    let out_label = validated.labels[0];

    let mut values = [Field::from(0u64); MAX_SPLIT_OUTPUTS];
    let mut nullifiers = [Field::from(0u64); MAX_SPLIT_OUTPUTS];
    let mut secrets = [Field::from(0u64); MAX_SPLIT_OUTPUTS];

    let mut sum = Field::from(0u64);
    for i in 0..MAX_SPLIT_OUTPUTS {
        values[i] = field_from_str(&w.split_values[i]);
        nullifiers[i] = field_from_str(&w.split_nullifiers[i]);
        secrets[i] = field_from_str(&w.split_secrets[i]);
        sum += values[i];
    }
    if sum != in_value {
        return Err(ValidateError::SplitSumMismatch);
    }

    for i in 0..MAX_SPLIT_OUTPUTS {
        if values[i] == Field::from(0u64) {
            if nullifiers[i] != Field::from(0u64) || secrets[i] != Field::from(0u64) {
                return Err(ValidateError::SplitInactiveSlotNonZero(i));
            }
            continue;
        }
        // OVERLORD F-9: match Circom — active slice nullifier ≠ input nullifier.
        if nullifiers[i] == validated.nullifiers[0] {
            return Err(ValidateError::SplitNullifierReusesInput(i));
        }
        for j in (i + 1)..MAX_SPLIT_OUTPUTS {
            if values[j] != Field::from(0u64) && nullifiers[i] == nullifiers[j] {
                return Err(ValidateError::SplitDuplicateNullifier(i, j));
            }
        }
    }

    let out_commitments = slice_commitments(out_label, validated.asset_ids[0], &values, &nullifiers, &secrets)?;
    let root = split_root(&out_commitments)?;

    let mut mux = [Field::from(0u64); 8];
    mux[0] = root;

    Ok(PublicOutputs {
        action: w.action,
        input_count: w.input_count,
        state_root,
        admitted_root,
        revoked_root,
        primary_value: Field::from(0u64),
        secondary_value: Field::from(0u64),
        out_commitment: Field::from(0u64),
        out_label: Field::from(0u64),
        nullifier_hashes: validated.nullifier_hashes,
        payee_id: Field::from(0u64),
        program_version: crate::constants::PROGRAM_VERSION,
        mux,
    })
}
