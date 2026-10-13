//! Witness layout — PROTOCOL.md §3 (JSON fixtures for M0 tests).

use serde::Deserialize;

use crate::merkle::MerklePath;
use crate::smt::SmtPath;

fn default_zero_string() -> String {
    "0".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputWitness {
    pub in_value: String,
    pub in_nullifier: String,
    pub in_secret: String,
    pub in_label: String,
    /// EVM `uint160(token)` as decimal field string (D1). Required — no silent default (OVERLORD F-4).
    pub in_asset_id: String,
    pub admitted_leaf_index: u64,
    pub state_path_elements: Vec<String>,
    pub state_path_indices: Vec<u8>,
    pub admitted_path_elements: Vec<String>,
    pub admitted_path_indices: Vec<u8>,
    pub revoked_smt_path_elements: Vec<String>,
    pub revoked_smt_path_indices: Vec<u8>,
    /// Actual SMT leaf at `smtKey(inLabel)` (0 if empty). F-5 non-inclusion.
    #[serde(default = "default_zero_string")]
    pub revoked_smt_leaf: String,
}

impl InputWitness {
    pub fn state_path(&self) -> MerklePath {
        MerklePath {
            path_elements: self
                .state_path_elements
                .iter()
                .map(|s| crate::poseidon::field_from_str(s))
                .collect(),
            path_indices: self.state_path_indices.clone(),
        }
    }

    pub fn admitted_path(&self) -> MerklePath {
        MerklePath {
            path_elements: self
                .admitted_path_elements
                .iter()
                .map(|s| crate::poseidon::field_from_str(s))
                .collect(),
            path_indices: self.admitted_path_indices.clone(),
        }
    }

    pub fn revoked_smt_path(&self) -> SmtPath {
        SmtPath {
            path_elements: self
                .revoked_smt_path_elements
                .iter()
                .map(|s| crate::poseidon::field_from_str(s))
                .collect(),
            path_indices: self.revoked_smt_path_indices.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendWitness {
    pub action: u8,
    pub input_count: u8,
    pub boundary_index: u8,
    pub state_root: String,
    pub admitted_root: String,
    pub revoked_root: String,
    pub primary_value: String,
    pub secondary_value: String,
    pub out_nullifier: String,
    pub out_secret: String,
    /// 20-byte EVM payee hex (no 0x prefix) for withdraw.
    pub raw_payee_hex: String,
    pub inputs: Vec<InputWitness>,
    #[serde(default)]
    pub chain_profile: String,
    #[serde(default)]
    pub chain_id: u64,
    /// SWAP mux 17–21 (evm-v1 chain profile).
    #[serde(default)]
    pub pool: String,
    #[serde(default)]
    pub dst_token: String,
    #[serde(default)]
    pub fee: String,
    #[serde(default)]
    pub min_amount_out: String,
    #[serde(default)]
    pub output_precommitment: String,
    /// Private destination note nullifier/secret — bind `outputPrecommitment`.
    #[serde(default)]
    pub dest_nullifier: String,
    #[serde(default)]
    pub dest_secret: String,
    /// Optional override for negative tests; MUST equal `inLabel[0]` when set.
    #[serde(default)]
    pub dest_label: String,
    /// SPLIT — eight output slices (§4.4).
    #[serde(default)]
    pub split_values: Vec<String>,
    #[serde(default)]
    pub split_nullifiers: Vec<String>,
    #[serde(default)]
    pub split_secrets: Vec<String>,
    #[serde(default)]
    pub expected_public: Vec<String>,
    #[serde(default)]
    pub submitted_public: Vec<String>,
}
