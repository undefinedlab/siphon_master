//! SWAP action — PROTOCOL.md §6.3 (D1)

use crate::commitment::{commitment, commitment_with_pre, precommitment};
use crate::poseidon::{field_from_str, Field};
use crate::public::PublicOutputs;
use crate::smt::load_domains;
use crate::witness::SpendWitness;

use super::common::validate_private_inputs;
use super::ValidateError;

pub fn validate_swap(w: &SpendWitness) -> Result<PublicOutputs, ValidateError> {
    if w.input_count != 1 {
        return Err(ValidateError::InvalidInputCount);
    }
    if w.boundary_index != 0 {
        return Err(ValidateError::InvalidBoundaryIndex);
    }

    let state_root = field_from_str(&w.state_root);
    let admitted_root = field_from_str(&w.admitted_root);
    let revoked_root = field_from_str(&w.revoked_root);
    let primary = field_from_str(&w.primary_value);
    let secondary = field_from_str(&w.secondary_value);
    let out_nullifier = field_from_str(&w.out_nullifier);
    let out_secret = field_from_str(&w.out_secret);

    let pool = field_from_str(&w.pool);
    let dst_token = field_from_str(&w.dst_token);
    let fee = field_from_str(&w.fee);
    // OVERLORD F-10: Uniswap V3 fee is uint24 — match Circom Num2Bits(24).
    const FEE_U24_MAX: u64 = (1u64 << 24) - 1;
    if fee > Field::from(FEE_U24_MAX) {
        return Err(ValidateError::SwapFeeOutOfRange);
    }
    let min_amount_out = field_from_str(&w.min_amount_out);
    let output_precommitment = field_from_str(&w.output_precommitment);

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

    if primary == Field::from(0u64) {
        return Err(ValidateError::SwapPrimaryZero);
    }

    let in_value = validated.values[0];
    if primary > in_value {
        return Err(ValidateError::SwapPrimaryExceedsInput);
    }
    if primary + secondary != in_value {
        return Err(ValidateError::SwapSumMismatch);
    }

    let in_label = validated.labels[0];
    let src_asset_id = validated.asset_ids[0];
    let dest_label = if w.dest_label.is_empty() {
        in_label
    } else {
        field_from_str(&w.dest_label)
    };
    if dest_label != in_label {
        return Err(ValidateError::SwapDestLabelMismatch);
    }

    if !w.dest_nullifier.is_empty() || !w.dest_secret.is_empty() {
        let dest_nf = field_from_str(&w.dest_nullifier);
        let dest_sec = field_from_str(&w.dest_secret);
        let expected_pre = precommitment(dest_nf, dest_sec)?;
        if expected_pre != output_precommitment {
            return Err(ValidateError::SwapOutputPrecommitmentMismatch);
        }
    }

    let out_commitment = if secondary == Field::from(0u64) {
        Field::from(0u64)
    } else {
        commitment(secondary, in_label, src_asset_id, out_nullifier, out_secret)?
    };

    let dest_commitment =
        commitment_with_pre(min_amount_out, dest_label, dst_token, output_precommitment)?;

    // OVERLORD F-1: D1 pool SWAP binds public[15] === 0 (no EOA payout in same action).
    if !w.raw_payee_hex.is_empty() && !w.raw_payee_hex.chars().all(|c| c == '0') {
        return Err(ValidateError::SwapPayeeMustBeZero);
    }
    let payee_id = Field::from(0u64);

    let mut mux = [Field::from(0u64); 8];
    mux[0] = pool;
    mux[1] = dst_token;
    mux[2] = fee;
    mux[3] = min_amount_out;
    mux[4] = output_precommitment;
    mux[5] = dest_commitment;
    mux[6] = src_asset_id; // public[23]
    // mux[7] = public[24] = 0

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
