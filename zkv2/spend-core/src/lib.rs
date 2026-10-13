//! Siphon v3 spend primitives — normative: [`PROTOCOL.md`](../PROTOCOL.md).

pub mod asp;
pub mod chain_profile;
pub mod commitment;
pub mod constants;
pub mod deposit;
pub mod deposit_public;
pub mod deposit_witness;
pub mod domains;
pub mod label;
pub mod merkle;
pub mod poseidon;
pub mod public;
pub mod smt;
pub mod split;
pub mod validate;
pub mod witness;

pub use asp::{
    empty_root, path_index_bind_ok, path_indices_from_leaf_index, verify_asp_inclusion, AspTree,
};
pub use chain_profile::{
    evm_address_to_field, evm_payee_field, pack_solana_vault_instance, pubkey_to_field,
    solana_payee_field, ChainProfile, EvmProfile, SolanaProfile, EVM_PROFILE_ID, SOLANA_PROFILE_ID,
    WSOL_MINT_ASCII,
};
pub use commitment::{commitment, commitment_with_pre, nullifier_hash, precommitment};
pub use constants::{
    LABEL_COMMIT_INDEX, PROGRAM_VERSION, PUBLIC_WIDTH, SMT_DEPTH, TREE_DEPTH, MAX_INPUTS,
};
pub use deposit_public::{DepositOutputs, DEPOSIT_PUBLIC_WIDTH};
pub use deposit_witness::DepositWitness;
pub use deposit::{asp_label_available, bind_deposit, mint_label_salted, DepositError};
pub use domains::Domains;
pub use label::mint_label_evm;
pub use merkle::{verify_inclusion, IncrementalMerkleTree, MerklePath};
pub use poseidon::{build_empty_subtrees, field_from_str, field_to_str, hash1, hash2, hash3};
pub use public::PublicOutputs;
pub use smt::{
    empty_leaf, leaf_hash, non_inclusion_path, revoked_tree_root, smt_key,
    verify_inclusion as verify_smt_inclusion, verify_non_inclusion, verify_revoked_membership,
    SmtPath,
};
pub use split::split_root;
pub use validate::{
    check_compliance_policy, swap_destination_label_ok, validate_deposit_public,
    validate_deposit_witness, validate_deposit_witness_json, validate_witness,
    validate_witness_json, validate_witness_public, ComplianceSnapshot, LabelStatus,
    PolicyError, SpendAction, ValidateError,
};
pub use witness::{InputWitness, SpendWitness};
