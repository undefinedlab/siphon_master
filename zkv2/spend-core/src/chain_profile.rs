//! Chain-specific identity encoding — PROTOCOL.md §1.2, §2.3, §16.
//!
//! Core spend rules are chain-agnostic; profiles map raw addresses / pubkeys to field elements.

use num_bigint::BigUint;

use crate::domains::Domains;
use crate::poseidon::{hash2, hash3, Field, PoseidonError};

pub const EVM_PROFILE_ID: &str = "evm-v1";
pub const SOLANA_PROFILE_ID: &str = "solana-v1";
pub const EVM_ADDRESS_LEN: usize = 20;
pub const SOLANA_PUBKEY_LEN: usize = 32;
pub const SOLANA_VAULT_INSTANCE_LEN: usize = 64; // programId || vaultPda
pub const PAYEE_RAW_LEN_EVM: usize = 32;
/// WSOL mint (native SOL assetId) — pinned for solana-v1.
pub const WSOL_MINT_ASCII: &str = "So11111111111111111111111111111111111111112";

/// Chain-specific encoding of vault instances and payees.
pub trait ChainProfile {
    fn profile_id(&self) -> &'static str;

    /// `vaultScopeId` — fixed per (chain, vault) deployment; used in label mint (§2.3).
    fn vault_scope_id(&self, vault_instance: &[u8]) -> Result<Field, PoseidonError>;

    /// `payeeId` — hash-bound payout identity in public inputs (§4.1 index 15, §6.5 index 17).
    fn payee_id(&self, raw_payee: &[u8]) -> Result<Field, PoseidonError>;

    /// On-chain label at deposit — §2.3.
    fn mint_label(&self, vault_instance: &[u8], deposit_nonce: u64) -> Result<Field, PoseidonError>;
}

/// EVM profile — normative: `chain-profiles/evm-v1.json`.
#[derive(Debug, Clone, Copy)]
pub struct EvmProfile {
    pub chain_id: u64,
}

impl EvmProfile {
    pub fn new(chain_id: u64) -> Self {
        Self { chain_id }
    }

    fn domains() -> Domains {
        Domains::load()
    }
}

impl ChainProfile for EvmProfile {
    fn profile_id(&self) -> &'static str {
        EVM_PROFILE_ID
    }

    fn vault_scope_id(&self, vault_instance: &[u8]) -> Result<Field, PoseidonError> {
        let addr = parse_evm_address(vault_instance)?;
        let d = Self::domains();
        hash3(
            d.chain_evm,
            Field::from(self.chain_id),
            evm_address_to_field(&addr),
        )
    }

    fn payee_id(&self, raw_payee: &[u8]) -> Result<Field, PoseidonError> {
        let d = Self::domains();
        hash2(d.payee, evm_payee_field(raw_payee)?)
    }

    fn mint_label(&self, vault_instance: &[u8], deposit_nonce: u64) -> Result<Field, PoseidonError> {
        let scope = self.vault_scope_id(vault_instance)?;
        let d = Self::domains();
        hash3(d.vault_scope, scope, Field::from(deposit_nonce))
    }
}

/// Solana profile — normative: `chain-profiles/solana-v1.json`.
///
/// `vault_instance` = `programId (32) || vaultPda (32)`.
/// Payee: `Poseidon(DOMAIN_PAYEE, Poseidon(DOMAIN_PAYEE_SOL_COMPRESS, pubkeyField))`.
#[derive(Debug, Clone, Copy, Default)]
pub struct SolanaProfile;

impl SolanaProfile {
    pub fn new() -> Self {
        Self
    }

    fn domains() -> Domains {
        Domains::load()
    }
}

impl ChainProfile for SolanaProfile {
    fn profile_id(&self) -> &'static str {
        SOLANA_PROFILE_ID
    }

    fn vault_scope_id(&self, vault_instance: &[u8]) -> Result<Field, PoseidonError> {
        let (program_id, vault_pda) = parse_solana_vault_instance(vault_instance)?;
        let d = Self::domains();
        hash3(
            d.chain_sol,
            pubkey_to_field(&program_id),
            pubkey_to_field(&vault_pda),
        )
    }

    fn payee_id(&self, raw_payee: &[u8]) -> Result<Field, PoseidonError> {
        let d = Self::domains();
        let payee_field = solana_payee_field(raw_payee)?;
        hash2(d.payee, payee_field)
    }

    fn mint_label(&self, vault_instance: &[u8], deposit_nonce: u64) -> Result<Field, PoseidonError> {
        let scope = self.vault_scope_id(vault_instance)?;
        let d = Self::domains();
        hash3(d.vault_scope, scope, Field::from(deposit_nonce))
    }
}

/// 20-byte EVM address → field (uint160).
pub fn evm_address_to_field(address: &[u8; EVM_ADDRESS_LEN]) -> Field {
    let mut buf = [0u8; 32];
    buf[12..32].copy_from_slice(address);
    Field::from(BigUint::from_bytes_be(&buf))
}

/// 20-byte address zero-padded to 32 bytes BE → field (`payeeField` in evm-v1 profile).
pub fn evm_payee_field(raw_payee: &[u8]) -> Result<Field, PoseidonError> {
    if raw_payee.len() != EVM_ADDRESS_LEN {
        return Err(PoseidonError::Hash(format!(
            "evm payee must be {EVM_ADDRESS_LEN} bytes, got {}",
            raw_payee.len()
        )));
    }
    let mut addr = [0u8; EVM_ADDRESS_LEN];
    addr.copy_from_slice(raw_payee);
    Ok(evm_address_to_field(&addr))
}

pub fn parse_evm_address(bytes: &[u8]) -> Result<[u8; EVM_ADDRESS_LEN], PoseidonError> {
    if bytes.len() != EVM_ADDRESS_LEN {
        return Err(PoseidonError::Hash(format!(
            "evm vault address must be {EVM_ADDRESS_LEN} bytes, got {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; EVM_ADDRESS_LEN];
    out.copy_from_slice(bytes);
    Ok(out)
}

/// 32-byte Solana pubkey → BN254 field (`BigUint(pubkey) mod r`).
pub fn pubkey_to_field(pubkey: &[u8; SOLANA_PUBKEY_LEN]) -> Field {
    Field::from(BigUint::from_bytes_be(pubkey))
}

/// `payeeField = Poseidon(DOMAIN_PAYEE_SOL_COMPRESS, pubkeyField)`.
pub fn solana_payee_field(raw_payee: &[u8]) -> Result<Field, PoseidonError> {
    if raw_payee.len() != SOLANA_PUBKEY_LEN {
        return Err(PoseidonError::Hash(format!(
            "solana payee must be {SOLANA_PUBKEY_LEN} bytes, got {}",
            raw_payee.len()
        )));
    }
    let mut pk = [0u8; SOLANA_PUBKEY_LEN];
    pk.copy_from_slice(raw_payee);
    let d = Domains::load();
    hash2(d.payee_sol_compress, pubkey_to_field(&pk))
}

pub fn parse_solana_vault_instance(
    bytes: &[u8],
) -> Result<([u8; SOLANA_PUBKEY_LEN], [u8; SOLANA_PUBKEY_LEN]), PoseidonError> {
    if bytes.len() != SOLANA_VAULT_INSTANCE_LEN {
        return Err(PoseidonError::Hash(format!(
            "solana vault instance must be {SOLANA_VAULT_INSTANCE_LEN} bytes (programId||vaultPda), got {}",
            bytes.len()
        )));
    }
    let mut program_id = [0u8; SOLANA_PUBKEY_LEN];
    let mut vault_pda = [0u8; SOLANA_PUBKEY_LEN];
    program_id.copy_from_slice(&bytes[..32]);
    vault_pda.copy_from_slice(&bytes[32..]);
    Ok((program_id, vault_pda))
}

pub fn pack_solana_vault_instance(
    program_id: &[u8; SOLANA_PUBKEY_LEN],
    vault_pda: &[u8; SOLANA_PUBKEY_LEN],
) -> [u8; SOLANA_VAULT_INSTANCE_LEN] {
    let mut out = [0u8; SOLANA_VAULT_INSTANCE_LEN];
    out[..32].copy_from_slice(program_id);
    out[32..].copy_from_slice(vault_pda);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poseidon::field_to_str;

    /// Frozen fixtures for `test-vectors/chain-profile-solana.json`.
    #[test]
    fn solana_scope_and_payee_stable() {
        let program_id = [0x11u8; 32];
        let vault_pda = [0x22u8; 32];
        let payee = [0x33u8; 32];
        let instance = pack_solana_vault_instance(&program_id, &vault_pda);
        let p = SolanaProfile::new();
        let scope = field_to_str(&p.vault_scope_id(&instance).unwrap());
        let label = field_to_str(&p.mint_label(&instance, 7).unwrap());
        let payee_field = field_to_str(&solana_payee_field(&payee).unwrap());
        let payee_id = field_to_str(&p.payee_id(&payee).unwrap());
        // Frozen in test-vectors/chain-profile-solana.json — do not change domains without regenerating.
        assert_eq!(
            scope,
            "19183590508245192203012639644333567682872289463675851048584515047362978462210"
        );
        assert_eq!(
            label,
            "1061004402692513216933771020149195198154924701359667231222699324797425238706"
        );
        assert_eq!(
            payee_field,
            "9788711792116879681416592013051398993099863931149600449620887524266175355908"
        );
        assert_eq!(
            payee_id,
            "16251131778136927336947831390974037088188521032891601592675718001963620016178"
        );
    }
}
