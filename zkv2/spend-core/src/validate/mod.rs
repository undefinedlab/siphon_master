//! PROTOCOL v3.3 validation — compliance policy + witness validator.

mod common;
mod deposit_witness;
mod merge;
mod ragequit;
mod split;
mod swap;
mod withdraw;

pub use common::{evm_payee_id, validate_private_inputs, ValidatedInputs};
pub use deposit_witness::{validate_deposit_public, validate_deposit_witness, validate_deposit_witness_json};

use thiserror::Error;

use crate::constants::{PUBLIC_WIDTH};
use crate::poseidon::{field_to_str, PoseidonError};
use crate::public::PublicOutputs;
use crate::witness::SpendWitness;

use crate::asp::AspError;
use crate::merkle::MerkleError;
use crate::smt::SmtError;

/// Mirrors on-chain `LabelStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LabelStatus {
    Pending = 0,
    Admitted = 1,
    Revoked = 2,
    Ragequit = 3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpendAction {
    Withdraw = 0,
    Merge = 1,
    Swap = 2,
    Split = 3,
    Ragequit = 4,
}

impl SpendAction {
    pub fn is_private_spend(self) -> bool {
        matches!(
            self,
            SpendAction::Withdraw
                | SpendAction::Merge
                | SpendAction::Swap
                | SpendAction::Split
        )
    }

    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(SpendAction::Withdraw),
            1 => Some(SpendAction::Merge),
            2 => Some(SpendAction::Swap),
            3 => Some(SpendAction::Split),
            4 => Some(SpendAction::Ragequit),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ComplianceSnapshot {
    pub action: SpendAction,
    pub label_status: LabelStatus,
    pub label_in_asp: bool,
    pub label_revoked_in_smt: bool,
    pub admitted_root_public: bool,
    pub revoked_root_public: bool,
    /// True iff `ComplianceHub.admittedRoot` is still `EMPTY_ASP_ROOT` (no labels published yet).
    pub admitted_root_empty: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PolicyError {
    #[error("private spend requires ASP inclusion")]
    NotAdmitted,
    #[error("private spend blocked: label revoked in SMT")]
    RevokedInSmt,
    #[error("private spend blocked: on-chain status Revoked")]
    OnChainRevoked,
    #[error("ragequit requires Pending or Revoked status")]
    RagequitBadStatus,
    #[error("ragequit forbidden while Admitted — use private withdraw")]
    RagequitWhileAdmitted,
    #[error("ragequit pending requires empty ASP (pre-first-admit); use revoked path after SMT insert")]
    RagequitPendingRequiresEmptyAsp,
    #[error("ragequit: SMT inclusion / membership failed")]
    RagequitNotRevoked,
    #[error("private spend requires current admittedRoot in public[3]")]
    StaleAdmittedRoot,
    #[error("private spend requires current revokedRoot in public[4]")]
    StaleRevokedRoot,
}

#[derive(Debug, Error)]
pub enum ValidateError {
    #[error("unsupported action")]
    UnsupportedAction,
    #[error("invalid inputCount for action")]
    InvalidInputCount,
    #[error("boundaryIndex out of range")]
    InvalidBoundaryIndex,
    #[error("inactive slot {0} must be zero")]
    InactiveSlotNonZero(usize),
    #[error("input {0}: value must be positive")]
    InputValueZero(usize),
    #[error("input {0}: label must be non-zero")]
    InputLabelZero(usize),
    #[error("input {0}: assetId must be non-zero")]
    InputAssetIdZero(usize),
    #[error("input {0}: assetId mismatch vs input 0")]
    AssetIdMismatch(usize),
    #[error("input {0}: state inclusion failed")]
    StateInclusionFailed(usize),
    #[error("input {0}: ASP inclusion failed")]
    AspInclusionFailed(usize),
    #[error("input {0}: ASP path index bind failed")]
    AspPathBindFailed(usize),
    #[error("input {0}: SMT non-inclusion failed")]
    SmtNonInclusionFailed(usize),
    #[error("duplicate nullifier at inputs {0} and {1}")]
    DuplicateNullifier(usize, usize),
    #[error("duplicate label at inputs {0} and {1}")]
    DuplicateLabel(usize, usize),
    #[error("withdraw: primaryValue must be positive")]
    WithdrawPrimaryZero,
    #[error("withdraw: value sum mismatch")]
    WithdrawSumMismatch,
    #[error("withdraw: change value exceeds boundary note value")]
    WithdrawChangeExceedsBoundary,
    #[error("merge: witness primaryValue must equal sum of inputs (public limb is 0)")]
    MergePrimaryMismatch,
    #[error("merge: secondaryValue must be zero")]
    MergeSecondaryNonZero,
    #[error("merge: boundary note must have max inValue (index {0} violates)")]
    MergeBoundaryNotMax(usize),
    #[error("swap: primaryValue must be positive")]
    SwapPrimaryZero,
    #[error("swap: primaryValue exceeds input")]
    SwapPrimaryExceedsInput,
    #[error("swap: value sum mismatch")]
    SwapSumMismatch,
    #[error("swap: destLabel must equal inLabel[0]")]
    SwapDestLabelMismatch,
    #[error("swap: outputPrecommitment mismatch")]
    SwapOutputPrecommitmentMismatch,
    #[error("swap: payeeId must be zero (D1 pool settlement / OVERLORD F-1)")]
    SwapPayeeMustBeZero,
    #[error("swap: fee must fit uint24 (Uniswap V3 / OVERLORD F-10)")]
    SwapFeeOutOfRange,
    #[error("split: slice vector must have 8 elements")]
    SplitSliceCount,
    #[error("split: primaryValue and secondaryValue must be zero")]
    SplitPublicValuesNonZero,
    #[error("split: slice sum mismatch")]
    SplitSumMismatch,
    #[error("split: inactive slice {0} has non-zero nullifier/secret")]
    SplitInactiveSlotNonZero(usize),
    #[error("split: slice {0} nullifier equals input nullifier")]
    SplitNullifierReusesInput(usize),
    #[error("split: duplicate nullifier at slices {0} and {1}")]
    SplitDuplicateNullifier(usize, usize),
    #[error("deposit: measured amount must be positive")]
    DepositZeroAmount,
    #[error("deposit: claimed amount != measured")]
    DepositAmountMismatch,
    #[error("deposit: userSalt must be non-zero")]
    DepositZeroSalt,
    #[error("deposit: user-supplied label forbidden")]
    DepositUserSuppliedLabel,
    #[error("deposit: label borrow")]
    DepositLabelBorrow,
    #[error("deposit: duplicate ASP label")]
    DepositDuplicateAspLabel,
    #[error("public limb {0} mismatch")]
    PublicMismatch(usize),
    #[error("unsupported chain profile")]
    UnsupportedProfile,
    #[error("outNullifier duplicates active input {0}")]
    OutNullifierDuplicate(usize),
    #[error(transparent)]
    Poseidon(#[from] PoseidonError),
    #[error(transparent)]
    Merkle(#[from] MerkleError),
    #[error(transparent)]
    Asp(#[from] AspError),
    #[error(transparent)]
    Smt(#[from] SmtError),
    #[error("invalid witness JSON")]
    InvalidWitnessJson,
    #[error(transparent)]
    Policy(#[from] PolicyError),
}

/// §5.1 / §5.2 / §7.2 / §8.2 policy (journey gate — no witness crypto).
pub fn check_compliance_policy(s: ComplianceSnapshot) -> Result<(), PolicyError> {
    if s.action == SpendAction::Ragequit {
        if !s.admitted_root_public || !s.revoked_root_public {
            return Err(PolicyError::StaleAdmittedRoot);
        }
        // Admitted: in ASP and not in SMT → private withdraw only.
        if s.label_in_asp && !s.label_revoked_in_smt {
            return Err(PolicyError::RagequitWhileAdmitted);
        }
        // Pending (v1): not in ASP, not in SMT, empty ASP only (§5.2.1).
        if !s.label_in_asp && !s.label_revoked_in_smt {
            if !s.admitted_root_empty {
                return Err(PolicyError::RagequitPendingRequiresEmptyAsp);
            }
            return Ok(());
        }
        // Revoked: in SMT (ASP membership irrelevant).
        if s.label_revoked_in_smt {
            return Ok(());
        }
        return Err(PolicyError::RagequitBadStatus);
    }

    if s.action.is_private_spend() {
        if !s.admitted_root_public {
            return Err(PolicyError::StaleAdmittedRoot);
        }
        if !s.revoked_root_public {
            return Err(PolicyError::StaleRevokedRoot);
        }
        if !s.label_in_asp {
            return Err(PolicyError::NotAdmitted);
        }
        if s.label_revoked_in_smt {
            return Err(PolicyError::RevokedInSmt);
        }
    }
    Ok(())
}

pub fn swap_destination_label_ok(public_out_label: &str, inserted_label: &str) -> bool {
    public_out_label == inserted_label
}

/// Validate witness and derive canonical `PublicOutputs` (M1–M5).
pub fn validate_witness(w: &SpendWitness) -> Result<PublicOutputs, ValidateError> {
    let action = SpendAction::from_u8(w.action).ok_or(ValidateError::UnsupportedAction)?;
    match action {
        SpendAction::Withdraw => withdraw::validate_withdraw(w),
        SpendAction::Merge => merge::validate_merge(w),
        SpendAction::Swap => swap::validate_swap(w),
        SpendAction::Split => split::validate_split(w),
        SpendAction::Ragequit => ragequit::validate_ragequit(w),
    }
}

pub fn validate_witness_public(
    w: &SpendWitness,
    submitted: &[String; PUBLIC_WIDTH],
) -> Result<PublicOutputs, ValidateError> {
    let derived = validate_witness(w)?;
    let limbs = derived.to_bn254_limbs();
    for (i, sub) in submitted.iter().enumerate() {
        if field_to_str(&limbs[i]) != *sub {
            return Err(ValidateError::PublicMismatch(i));
        }
    }
    Ok(derived)
}

pub fn validate_witness_json(json: &str) -> Result<PublicOutputs, ValidateError> {
    let w: SpendWitness =
        serde_json::from_str(json).map_err(|_| ValidateError::InvalidWitnessJson)?;
    validate_witness(&w)
}

#[cfg(test)]
mod compliance_tests {
    use super::*;
    use crate::constants::test_vectors_dir;
    use std::fs;

    #[test]
    fn ragequit_admitted_witness_fails() {
        let path = test_vectors_dir().join("ragequit-admitted-witness-fail.json");
        let json = fs::read_to_string(path).unwrap();
        let err = validate_witness_json(&json).unwrap_err();
        assert!(matches!(
            err,
            ValidateError::Policy(PolicyError::RagequitWhileAdmitted)
        ));
    }

    #[test]
    fn ragequit_revoked_witness_ok() {
        let path = test_vectors_dir().join("ragequit-revoked-witness-ok.json");
        let json = fs::read_to_string(path).unwrap();
        validate_witness_json(&json).expect("revoked ragequit");
    }

    #[test]
    fn ragequit_revoked_fixture_has_smt_inclusion_path() {
        use crate::poseidon::field_from_str;
        use crate::smt::{
            leaf_hash, load_domains, smt_key, verify_inclusion as verify_smt_inclusion,
        };
        use crate::witness::SpendWitness;

        let path = test_vectors_dir().join("ragequit-revoked-witness-ok.json");
        let json = fs::read_to_string(path).unwrap();
        let w: SpendWitness = serde_json::from_str(&json).unwrap();
        let inp = &w.inputs[0];
        let in_label = field_from_str(&inp.in_label);
        let revoked_root = field_from_str(&w.revoked_root);
        let (dk, dl) = load_domains();
        let key = smt_key(in_label, dk).unwrap();
        let smt_path = inp.revoked_smt_path();
        let leaf = leaf_hash(in_label, dl).unwrap();
        assert!(
            verify_smt_inclusion(key, revoked_root, &smt_path, leaf).unwrap(),
            "F-3: revoked ragequit fixture must carry valid SMT inclusion path"
        );
    }

    #[test]
    fn compliance_pending_requires_empty_asp() {
        let err = check_compliance_policy(ComplianceSnapshot {
            action: SpendAction::Ragequit,
            label_status: LabelStatus::Pending,
            label_in_asp: false,
            label_revoked_in_smt: false,
            admitted_root_public: true,
            revoked_root_public: true,
            admitted_root_empty: false,
        })
        .unwrap_err();
        assert_eq!(err, PolicyError::RagequitPendingRequiresEmptyAsp);
    }

    /// OVERLORD F-1: SWAP must not carry a non-zero payeeId (D1 pool settlement).
    #[test]
    fn swap_nonzero_payee_rejected() {
        let path = test_vectors_dir().join("swap-ok.json");
        let json = fs::read_to_string(path).unwrap();
        let mut w: crate::witness::SpendWitness = serde_json::from_str(&json).unwrap();
        w.raw_payee_hex = "0000000000000000000000000000000000000001".into();
        let err = validate_witness(&w).unwrap_err();
        assert!(matches!(err, ValidateError::SwapPayeeMustBeZero));
    }

    /// OVERLORD F-10: fee above uint24 must fail closed.
    #[test]
    fn swap_fee_above_u24_rejected() {
        let path = test_vectors_dir().join("swap-ok.json");
        let json = fs::read_to_string(path).unwrap();
        let mut w: crate::witness::SpendWitness = serde_json::from_str(&json).unwrap();
        w.fee = ((1u64 << 24)).to_string();
        let err = validate_witness(&w).unwrap_err();
        assert!(matches!(err, ValidateError::SwapFeeOutOfRange));
    }

    /// OVERLORD F-9: SPLIT slice nullifier must not reuse the input nullifier.
    #[test]
    fn split_reuses_input_nullifier_rejected() {
        let path = test_vectors_dir().join("split-ok.json");
        let json = fs::read_to_string(path).unwrap();
        let mut w: crate::witness::SpendWitness = serde_json::from_str(&json).unwrap();
        let input_nf = w.inputs[0].in_nullifier.clone();
        // First active slice: copy input nullifier (Circom vsIn would reject).
        w.split_nullifiers[0] = input_nf;
        let err = validate_witness(&w).unwrap_err();
        assert!(matches!(err, ValidateError::SplitNullifierReusesInput(0)));
    }

    /// §6.1 (v4): fractional change — secondary strictly between 0 and boundary value validates.
    /// withdraw-w3-ok has inputs [400,350,250], boundaryIndex=2 (value 250). Set secondary=100
    /// (0 < 100 < 250) and primary = sum - secondary = 900; the deriver builds the change note.
    #[test]
    fn withdraw_fractional_change_ok() {
        let path = test_vectors_dir().join("withdraw-w3-ok.json");
        let json = fs::read_to_string(path).unwrap();
        let mut w: crate::witness::SpendWitness = serde_json::from_str(&json).unwrap();
        assert_eq!(w.boundary_index, 2, "fixture boundary assumption");
        // sum = 400+350+250 = 1000; carve 100 change off the boundary note (250).
        w.primary_value = "900".to_string();
        w.secondary_value = "100".to_string();
        let out = validate_witness(&w).expect("fractional change must validate under §6.1 v4");
        // change note is non-zero (commitment present) and program version is 4.
        assert_ne!(out.out_commitment, crate::poseidon::Field::from(0u64));
        assert_eq!(out.program_version, crate::constants::PROGRAM_VERSION);
    }

    /// §6.1 (v4): change exceeding the boundary note value must fail closed.
    /// boundaryIndex=2 (value 250); secondary=300 > 250 → WithdrawChangeExceedsBoundary.
    #[test]
    fn withdraw_change_exceeds_boundary_rejected() {
        let path = test_vectors_dir().join("withdraw-w3-ok.json");
        let json = fs::read_to_string(path).unwrap();
        let mut w: crate::witness::SpendWitness = serde_json::from_str(&json).unwrap();
        // sum = 1000; secondary 300 > boundary value 250, primary = 700 keeps sum conserved.
        w.primary_value = "700".to_string();
        w.secondary_value = "300".to_string();
        let err = validate_witness(&w).unwrap_err();
        assert!(matches!(err, ValidateError::WithdrawChangeExceedsBoundary));
    }

    /// OVERLORD F-4: missing inAssetId must fail deserialize (no silent default).
    #[test]
    fn missing_in_asset_id_fails_deserialize() {
        let path = test_vectors_dir().join("swap-ok.json");
        let mut v: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        v["inputs"][0]
            .as_object_mut()
            .unwrap()
            .remove("inAssetId");
        let err = serde_json::from_value::<crate::witness::SpendWitness>(v).unwrap_err();
        assert!(err.to_string().contains("inAssetId") || err.to_string().contains("in_asset_id") || err.to_string().contains("missing field"));
    }
}
