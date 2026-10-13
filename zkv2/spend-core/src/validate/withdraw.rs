//! WITHDRAW action — PROTOCOL.md §6.1 (D1)

use crate::commitment::commitment;
use crate::constants::MAX_INPUTS;
use crate::poseidon::{field_from_str, Field};
use crate::public::PublicOutputs;
use crate::smt::load_domains;
use crate::witness::SpendWitness;

use super::common::{resolve_payee_id, sum_values, validate_private_inputs};
use super::ValidateError;

pub fn validate_withdraw(w: &SpendWitness) -> Result<PublicOutputs, ValidateError> {
    if w.input_count < 1 || w.input_count as usize > MAX_INPUTS {
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

    if primary == Field::from(0u64) {
        return Err(ValidateError::WithdrawPrimaryZero);
    }

    let sum = sum_values(&validated.values, n);
    if sum != primary + secondary {
        return Err(ValidateError::WithdrawSumMismatch);
    }

    // Fractional change (PROGRAM_VERSION 4, §6.1): change may be any value in [0, boundary].
    // Carved from the boundary note; all other inputs fully consumed. Mirrors the circuit's
    // LessEqThan(128) on secondaryValue vs the boundary note value.
    let boundary_value = validated.values[k];
    if secondary > boundary_value {
        return Err(ValidateError::WithdrawChangeExceedsBoundary);
    }

    let out_label = validated.labels[k];
    let asset_id = validated.asset_ids[0];
    let out_commitment = if secondary == Field::from(0u64) {
        Field::from(0u64)
    } else {
        commitment(secondary, out_label, asset_id, out_nullifier, out_secret)?
    };

    let payee_id = resolve_payee_id(&w.chain_profile, &w.raw_payee_hex, w.chain_id)?;


    let mut mux = [Field::from(0u64); 8];
    mux[0] = asset_id; // public[17]

    Ok(PublicOutputs {
        action: w.action,
        input_count: w.input_count,
        state_root,
        admitted_root,
        revoked_root,
        primary_value: primary,
        secondary_value: secondary,
        out_commitment,
        out_label: Field::from(0u64),
        nullifier_hashes: validated.nullifier_hashes,
        payee_id,
        program_version: crate::constants::PROGRAM_VERSION,
        mux,
    })
}
