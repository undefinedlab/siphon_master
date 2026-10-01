//! Deposit orchestration — measured asset pull, protocol label mint, and note insertion.

use siphon_kernel_types::KernelError;

use crate::adapters::{AssetAdapter, MeasuredDelta};
use crate::note_tree::NoteTree;
use crate::poseidon::{
    field_from_be_bytes, field_from_le_bytes, field_from_u64, field_to_le_bytes, hash2, hash3,
    DOMAIN_VAULT_SCOPE,
};
use crate::state::VaultState;

#[derive(Clone, Debug)]
pub struct DepositRequest {
    pub mint: [u8; 32],
    pub amount: u64,
    pub user_salt: [u8; 32],
    pub precommitment: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositReceipt {
    pub leaf_index: u64,
    pub label: [u8; 32],
    pub note_commitment: [u8; 32],
    pub measured: MeasuredDelta,
    pub deposit_nonce: u64,
}

/// Matches spend-core:
/// `label = H(H(DOMAIN_VAULT_SCOPE, vaultScopeId, nonce), userSalt)` and
/// `commitment = H(H(amount, label, assetId), precommitment)`.
pub fn execute_deposit<A: AssetAdapter>(
    vault: &mut VaultState,
    tree: &mut NoteTree,
    adapter: &A,
    req: &DepositRequest,
) -> Result<DepositReceipt, KernelError> {
    if vault.deposits_paused {
        return Err(KernelError::DepositsPaused);
    }
    if req.amount == 0 || req.user_salt == [0u8; 32] {
        return Err(KernelError::AdapterDeltaMismatch);
    }
    let measured = adapter.pull(&req.mint, req.amount)?;
    if measured.amount != req.amount {
        return Err(KernelError::AdapterDeltaMismatch);
    }
    let deposit_nonce = vault.deposit_nonce;
    let stem = hash3(
        field_from_u64(DOMAIN_VAULT_SCOPE),
        field_from_le_bytes(&vault.vault_scope_id),
        field_from_u64(deposit_nonce),
    )?;
    let label_field = hash2(stem, field_from_le_bytes(&req.user_salt))?;
    let inner = hash3(
        field_from_u64(measured.amount),
        label_field,
        field_from_be_bytes(&req.mint),
    )?;
    let commitment_field = hash2(inner, field_from_le_bytes(&req.precommitment))?;
    let label = field_to_le_bytes(&label_field);
    let note_commitment = field_to_le_bytes(&commitment_field);
    let leaf_index = tree.insert(note_commitment)?;
    vault.state_root = tree.root;
    vault.deposit_nonce = deposit_nonce
        .checked_add(1)
        .ok_or(KernelError::AdapterDeltaMismatch)?;
    Ok(DepositReceipt {
        leaf_index,
        label,
        note_commitment,
        measured,
        deposit_nonce,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::SplAssetAdapter;

    #[test]
    fn deposit_inserts_and_bumps_nonce() {
        let mut vault = VaultState {
            vault_scope_id: [1u8; 32],
            program_version: [4u8; 32],
            deposit_nonce: 0,
            state_root: [0u8; 32],
            deposits_paused: false,
            action_paused_mask: 0,
        };
        let mut tree = NoteTree::new(32);
        let adapter = SplAssetAdapter::permissive();
        let req = DepositRequest {
            mint: [9u8; 32],
            amount: 100,
            user_salt: [2u8; 32],
            precommitment: [3u8; 32],
        };
        let r = execute_deposit(&mut vault, &mut tree, &adapter, &req).unwrap();
        assert_eq!(r.leaf_index, 0);
        assert_eq!(r.deposit_nonce, 0);
        assert_eq!(vault.deposit_nonce, 1);
        assert_eq!(vault.state_root, tree.root);
    }
}
