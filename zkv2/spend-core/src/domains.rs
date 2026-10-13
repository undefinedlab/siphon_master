use crate::poseidon::{field_from_str, Field};

/// Load all domain separators from `test-vectors/domains.json`.
#[derive(Debug, Clone, Copy)]
pub struct Domains {
    pub smt_key: Field,
    pub smt_leaf: Field,
    pub vault_scope: Field,
    pub payee: Field,
    pub chain_evm: Field,
    pub chain_sol: Field,
    pub payee_sol_compress: Field,
}

impl Domains {
    pub fn load() -> Self {
        // Embedded for zkVM guests (no filesystem). Host tests use the same constants.
        const RAW: &str = include_str!("../../test-vectors/domains.json");
        let v: serde_json::Value = serde_json::from_str(RAW).expect("parse domains");
        Self {
            smt_key: field_from_str(v["DOMAIN_SMT_KEY"].as_str().unwrap()),
            smt_leaf: field_from_str(v["DOMAIN_SMT_LEAF"].as_str().unwrap()),
            vault_scope: field_from_str(v["DOMAIN_VAULT_SCOPE"].as_str().unwrap()),
            payee: field_from_str(v["DOMAIN_PAYEE"].as_str().unwrap()),
            chain_evm: field_from_str(v["DOMAIN_CHAIN_EVM"].as_str().unwrap()),
            chain_sol: field_from_str(v["DOMAIN_CHAIN_SOL"].as_str().unwrap()),
            payee_sol_compress: field_from_str(v["DOMAIN_PAYEE_SOL_COMPRESS"].as_str().unwrap()),
        }
    }
}

/// Back-compat helper for SMT tests.
pub fn load_smt_domains() -> (Field, Field) {
    let d = Domains::load();
    (d.smt_key, d.smt_leaf)
}
