//! RAGEQUIT action — PROTOCOL.md §5.2, §6.5

use crate::asp::{empty_root, verify_asp_inclusion};
use crate::commitment::{commitment, nullifier_hash};
use crate::merkle::verify_inclusion;
use crate::poseidon::{field_from_str, Field};
use crate::public::PublicOutputs;
use crate::smt::{
    leaf_hash, load_domains, smt_key, verify_inclusion as verify_smt_inclusion,
    verify_non_inclusion,
};
use crate::witness::SpendWitness;

use super::common::resolve_payee_id;
use super::ValidateError;

pub fn validate_ragequit(w: &SpendWitness) -> Result<PublicOutputs, ValidateError> {
    if w.input_count != 1 {
        return Err(ValidateError::InvalidInputCount);
    }
    if w.boundary_index != 0 {
        return Err(ValidateError::InvalidBoundaryIndex);
    }
    if w.inputs.is_empty() {
        return Err(ValidateError::InvalidInputCount);
    }

    let inp = &w.inputs[0];
    let in_value = field_from_str(&inp.in_value);
    let in_label = field_from_str(&inp.in_label);
    let in_asset_id = field_from_str(&inp.in_asset_id);
    let in_nullifier = field_from_str(&inp.in_nullifier);
    let in_secret = field_from_str(&inp.in_secret);

    if in_value == Field::from(0u64) {
        return Err(ValidateError::InputValueZero(0));
    }
    if in_label == Field::from(0u64) {
        return Err(ValidateError::InputLabelZero(0));
    }
    if in_asset_id == Field::from(0u64) {
        return Err(ValidateError::InputAssetIdZero(0));
    }

    let state_root = field_from_str(&w.state_root);
    let admitted_root = field_from_str(&w.admitted_root);
    let revoked_root = field_from_str(&w.revoked_root);
    let empty_asp = empty_root();

    let note_commitment = commitment(in_value, in_label, in_asset_id, in_nullifier, in_secret)?;
    if !verify_inclusion(note_commitment, state_root, &inp.state_path())? {
        return Err(ValidateError::StateInclusionFailed(0));
    }

    // Nullifier is published at public[9] and burned on-chain (§8.3) — note cannot be spent again.
    let nh = nullifier_hash(in_nullifier)?;
    let mut nullifier_hashes = [Field::from(0u64); 6];
    nullifier_hashes[0] = nh;

    let (domain_key, domain_leaf) = load_domains();
    let key = smt_key(in_label, domain_key)?;
    let smt_path = inp.revoked_smt_path();
    let my_leaf = leaf_hash(in_label, domain_leaf)?;
    let claimed_leaf = field_from_str(&inp.revoked_smt_leaf);

    let asp_ok = verify_asp_inclusion(
        in_label,
        admitted_root,
        &inp.admitted_path(),
        Some(inp.admitted_leaf_index),
    )
    .unwrap_or(false);

    let smt_non_ok =
        verify_non_inclusion(key, revoked_root, &smt_path, claimed_leaf, my_leaf).unwrap_or(false);
    let leaf = leaf_hash(in_label, domain_leaf)?;
    let smt_inc_ok =
        verify_smt_inclusion(key, revoked_root, &smt_path, leaf).unwrap_or(false);

    // §5.2.1 v1 secure branches (matches Circom `ragequit.circom`):
    //   Revoked — SMT inclusion path (same check as circuit).
    //   Pending — SMT non-inclusion ∧ label ∉ ASP ∧ admittedRoot == EMPTY_ASP_ROOT only.
    let revoked_branch = smt_inc_ok;
    let pending_branch = smt_non_ok && !asp_ok && admitted_root == empty_asp;

    if asp_ok && smt_non_ok && !revoked_branch {
        return Err(ValidateError::Policy(
            super::PolicyError::RagequitWhileAdmitted,
        ));
    }
    if !pending_branch && !revoked_branch {
        if smt_non_ok && !asp_ok && admitted_root != empty_asp {
            return Err(ValidateError::Policy(
                super::PolicyError::RagequitPendingRequiresEmptyAsp,
            ));
        }
        return Err(ValidateError::Policy(super::PolicyError::RagequitBadStatus));
    }

    let primary = in_value;
    let out_commitment = commitment(primary, in_label, in_asset_id, in_nullifier, in_secret)?;

    let payee_id = resolve_payee_id(&w.chain_profile, &w.raw_payee_hex, w.chain_id)?;


    let mut mux = [Field::from(0u64); 8];
    mux[0] = payee_id;
    mux[1] = in_asset_id; // public[18]

    Ok(PublicOutputs {
        action: w.action,
        input_count: w.input_count,
        state_root,
        admitted_root,
        revoked_root,
        primary_value: primary,
        secondary_value: Field::from(0u64),
        out_commitment,
        out_label: Field::from(0u64),
        nullifier_hashes,
        payee_id: Field::from(0u64),
        program_version: crate::constants::PROGRAM_VERSION,
        mux,
    })
}
