//! Deposit witness validation — PROTOCOL.md §2.7.

use crate::deposit::{bind_deposit, DepositError};
use crate::deposit_public::DepositOutputs;
use crate::deposit_witness::DepositWitness;
use crate::domains::Domains;
use crate::poseidon::{field_from_str, field_to_str};

use super::ValidateError;

pub fn validate_deposit_witness(w: &DepositWitness) -> Result<DepositOutputs, ValidateError> {
    let measured = field_from_str(&w.measured_amount);
    let claimed = field_from_str(&w.claimed_amount);
    let user_salt = field_from_str(&w.user_salt);
    let nullifier = field_from_str(&w.nullifier);
    let secret = field_from_str(&w.secret);
    let vault_scope_id = field_from_str(&w.vault_scope_id);

    if !w.chain_profile.is_empty()
        && w.chain_profile != "evm-v1"
        && w.chain_profile != "solana-v1"
    {
        return Err(ValidateError::UnsupportedProfile);
    }

    let user_label = w
        .user_supplied_label
        .as_ref()
        .map(|s| field_from_str(s));

    let d = Domains::load();
    let (_label, commitment) = bind_deposit(
        measured,
        claimed,
        d.vault_scope,
        vault_scope_id,
        w.deposit_nonce,
        user_salt,
        field_from_str(&w.asset_id),
        nullifier,
        secret,
        user_label,
    )
    .map_err(deposit_err)?;

    Ok(DepositOutputs {
        measured_amount: measured,
        commitment,
        deposit_nonce: w.deposit_nonce,
        vault_scope_id,
        program_version: crate::constants::PROGRAM_VERSION,
    })
}

pub fn validate_deposit_witness_json(json: &str) -> Result<DepositOutputs, ValidateError> {
    let w: DepositWitness =
        serde_json::from_str(json).map_err(|_| ValidateError::InvalidWitnessJson)?;
    validate_deposit_witness(&w)
}

pub fn validate_deposit_public(
    w: &DepositWitness,
    submitted: &[String],
) -> Result<DepositOutputs, ValidateError> {
    let derived = validate_deposit_witness(w)?;
    let limbs = derived.limb_strings();
    for (i, sub) in submitted.iter().enumerate() {
        if i >= limbs.len() {
            break;
        }
        if limbs[i] != *sub {
            return Err(ValidateError::PublicMismatch(i));
        }
    }
    if !w.expected_label.is_empty() {
        let d = Domains::load();
        let user_salt = field_from_str(&w.user_salt);
        let vault_scope_id = field_from_str(&w.vault_scope_id);
        let label = crate::deposit::mint_label_salted(
            d.vault_scope,
            vault_scope_id,
            w.deposit_nonce,
            user_salt,
        )
        .map_err(deposit_err)?;
        if field_to_str(&label) != w.expected_label {
            return Err(ValidateError::PublicMismatch(0));
        }
    }
    if !w.expected_commitment.is_empty() && field_to_str(&derived.commitment) != w.expected_commitment
    {
        return Err(ValidateError::PublicMismatch(1));
    }
    Ok(derived)
}

fn deposit_err(e: DepositError) -> ValidateError {
    match e {
        DepositError::ZeroAmount => ValidateError::DepositZeroAmount,
        DepositError::AmountMismatch => ValidateError::DepositAmountMismatch,
        DepositError::ZeroSalt => ValidateError::DepositZeroSalt,
        DepositError::UserSuppliedLabel => ValidateError::DepositUserSuppliedLabel,
        DepositError::LabelBorrow => ValidateError::DepositLabelBorrow,
        DepositError::DuplicateAspLabel => ValidateError::DepositDuplicateAspLabel,
        DepositError::Poseidon(p) => ValidateError::Poseidon(p),
    }
}
