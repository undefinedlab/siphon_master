//! Shared private-spend input checks (§5.1) and helpers.

use crate::asp::{path_index_bind_ok, verify_asp_inclusion};
use crate::commitment::{commitment, nullifier_hash};
use crate::constants::MAX_INPUTS;
use crate::merkle::verify_inclusion;
use crate::poseidon::Field;
use crate::smt::{leaf_hash, load_domains, smt_key, verify_non_inclusion};
use crate::witness::InputWitness;

use super::ValidateError;

pub struct ValidatedInputs {
    pub values: [Field; MAX_INPUTS],
    pub labels: [Field; MAX_INPUTS],
    pub asset_ids: [Field; MAX_INPUTS],
    pub nullifiers: [Field; MAX_INPUTS],
    pub nullifier_hashes: [Field; 6],
    pub input_count: usize,
}

pub fn validate_private_inputs(
    inputs: &[InputWitness],
    input_count: usize,
    state_root: Field,
    admitted_root: Field,
    revoked_root: Field,
    domain_smt_key: Field,
    out_nullifier: Field,
) -> Result<ValidatedInputs, ValidateError> {
    if inputs.len() < input_count {
        return Err(ValidateError::InvalidInputCount);
    }

    let (_, domain_smt_leaf) = load_domains();
    let mut values = [Field::from(0u64); MAX_INPUTS];
    let mut labels = [Field::from(0u64); MAX_INPUTS];
    let mut asset_ids = [Field::from(0u64); MAX_INPUTS];
    let mut nullifiers = [Field::from(0u64); MAX_INPUTS];
    let mut nullifier_hashes = [Field::from(0u64); 6];

    for i in 0..input_count {
        let inp = &inputs[i];
        let in_value = crate::poseidon::field_from_str(&inp.in_value);
        let in_label = crate::poseidon::field_from_str(&inp.in_label);
        let in_asset_id = crate::poseidon::field_from_str(&inp.in_asset_id);
        let in_nullifier = crate::poseidon::field_from_str(&inp.in_nullifier);
        let in_secret = crate::poseidon::field_from_str(&inp.in_secret);

        if in_value == Field::from(0u64) {
            return Err(ValidateError::InputValueZero(i));
        }
        if in_label == Field::from(0u64) {
            return Err(ValidateError::InputLabelZero(i));
        }
        if in_asset_id == Field::from(0u64) {
            return Err(ValidateError::InputAssetIdZero(i));
        }

        let note_commitment = commitment(in_value, in_label, in_asset_id, in_nullifier, in_secret)?;
        let state_path = inp.state_path();
        if !verify_inclusion(note_commitment, state_root, &state_path)? {
            return Err(ValidateError::StateInclusionFailed(i));
        }

        let asp_path = inp.admitted_path();
        path_index_bind_ok(inp.admitted_leaf_index, &asp_path.path_indices)
            .map_err(|_| ValidateError::AspPathBindFailed(i))?;
        if !verify_asp_inclusion(in_label, admitted_root, &asp_path, Some(inp.admitted_leaf_index))?
        {
            return Err(ValidateError::AspInclusionFailed(i));
        }

        let key = smt_key(in_label, domain_smt_key)?;
        let my_leaf = leaf_hash(in_label, domain_smt_leaf)?;
        let claimed_leaf = crate::poseidon::field_from_str(&inp.revoked_smt_leaf);
        let smt_path = inp.revoked_smt_path();
        if !verify_non_inclusion(key, revoked_root, &smt_path, claimed_leaf, my_leaf)? {
            return Err(ValidateError::SmtNonInclusionFailed(i));
        }

        let nh = nullifier_hash(in_nullifier)?;
        values[i] = in_value;
        labels[i] = in_label;
        asset_ids[i] = in_asset_id;
        nullifiers[i] = in_nullifier;
        nullifier_hashes[i] = nh;
    }

    for i in 0..input_count {
        for j in (i + 1)..input_count {
            if nullifiers[i] == nullifiers[j] {
                return Err(ValidateError::DuplicateNullifier(i, j));
            }
            if labels[i] == labels[j] {
                return Err(ValidateError::DuplicateLabel(i, j));
            }
        }
        if nullifiers[i] == out_nullifier {
            return Err(ValidateError::OutNullifierDuplicate(i));
        }
        if asset_ids[i] != asset_ids[0] {
            return Err(ValidateError::AssetIdMismatch(i));
        }
    }

    Ok(ValidatedInputs {
        values,
        labels,
        asset_ids,
        nullifiers,
        nullifier_hashes,
        input_count,
    })
}

pub fn evm_payee_id(raw_payee_hex: &str, chain_id: u64) -> Result<Field, ValidateError> {
    use crate::chain_profile::{ChainProfile, EvmProfile};
    let payee_bytes = hex::decode(raw_payee_hex).map_err(|_| ValidateError::UnsupportedProfile)?;
    let profile = EvmProfile::new(if chain_id == 0 { 84532 } else { chain_id });
    Ok(profile.payee_id(&payee_bytes)?)
}

pub fn solana_payee_id(raw_payee_hex: &str) -> Result<Field, ValidateError> {
    use crate::chain_profile::{ChainProfile, SolanaProfile};
    let payee_bytes = hex::decode(raw_payee_hex).map_err(|_| ValidateError::UnsupportedProfile)?;
    Ok(SolanaProfile::new().payee_id(&payee_bytes)?)
}

pub fn resolve_payee_id(
    chain_profile: &str,
    raw_payee_hex: &str,
    chain_id: u64,
) -> Result<Field, ValidateError> {
    if chain_profile.is_empty() || chain_profile == "evm-v1" {
        evm_payee_id(raw_payee_hex, chain_id)
    } else if chain_profile == "solana-v1" {
        solana_payee_id(raw_payee_hex)
    } else {
        Err(ValidateError::UnsupportedProfile)
    }
}

pub fn sum_values(values: &[Field; MAX_INPUTS], n: usize) -> Field {
    values[..n]
        .iter()
        .fold(Field::from(0u64), |acc, v| acc + *v)
}
