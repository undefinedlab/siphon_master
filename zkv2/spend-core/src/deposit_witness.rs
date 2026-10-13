//! Deposit witness layout — PROTOCOL.md §2.3, §2.7.

use serde::Deserialize;

fn default_asset_id() -> String {
    "4096".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositWitness {
    pub measured_amount: String,
    /// MUST equal `measuredAmount` (note amount is the token delta).
    pub claimed_amount: String,
    pub user_salt: String,
    /// EVM `uint160(token)` — D1 asset-bound deposit.
    #[serde(default = "default_asset_id")]
    pub asset_id: String,
    pub nullifier: String,
    pub secret: String,
    pub deposit_nonce: u64,
    pub vault_scope_id: String,
    #[serde(default)]
    pub chain_profile: String,
    #[serde(default)]
    pub chain_id: u64,
    /// Negative tests only — MUST be absent / null in production.
    #[serde(default)]
    pub user_supplied_label: Option<String>,
    #[serde(default)]
    pub expected_public: Vec<String>,
    #[serde(default)]
    pub expected_label: String,
    #[serde(default)]
    pub expected_commitment: String,
}
