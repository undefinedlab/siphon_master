//! Label mint — PROTOCOL.md §2.3 (delegates to active chain profile).

use crate::chain_profile::{ChainProfile, EvmProfile};
use crate::poseidon::{Field, PoseidonError};

/// Mint label for EVM vault deposit.
pub fn mint_label_evm(
    chain_id: u64,
    vault_address: &[u8],
    deposit_nonce: u64,
) -> Result<Field, PoseidonError> {
    EvmProfile::new(chain_id).mint_label(vault_address, deposit_nonce)
}
