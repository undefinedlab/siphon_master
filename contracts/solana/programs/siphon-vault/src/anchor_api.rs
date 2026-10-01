//! Anchor-facing instruction surface expressed as host-callable handlers.
//!
//! The BPF crate can map Anchor account validation onto these functions without duplicating
//! kernel logic. Account ownership, signer, bump, and CPI checks remain Anchor-layer concerns.

use siphon_kernel_types::{KernelError, PublicInputs};

use crate::adapters::AssetAdapter;
use crate::deposit_flow::{execute_deposit, DepositReceipt, DepositRequest};
use crate::note_tree::NoteTree;
use crate::pending_inputs::PendingInputsAccount;
use crate::poseidon::vault_scope_id;
use crate::spend_flow::{execute_spend, SpendContext, SpendReceipt};
use crate::state::{ComplianceState, VaultState};
use crate::verify::VerifySpend;

/// Stable instruction discriminants for the Phase-1 Anchor IDL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultInstruction {
    InitializeVault,
    SetCompliance,
    Deposit,
    CommitPublicInputs,
    Spend,
}

pub fn initialize_vault(
    program_id: &[u8; 32],
    vault_pda: &[u8; 32],
    program_version: [u8; 32],
) -> Result<(VaultState, NoteTree), KernelError> {
    let tree = NoteTree::default();
    let vault = VaultState {
        vault_scope_id: vault_scope_id(program_id, vault_pda)?,
        program_version,
        deposit_nonce: 0,
        state_root: tree.root,
        deposits_paused: false,
        action_paused_mask: 0,
    };
    Ok((vault, tree))
}

pub fn set_compliance(
    compliance: &mut ComplianceState,
    admitted_root: [u8; 32],
    revoked_root: [u8; 32],
) {
    compliance.admitted_root = admitted_root;
    compliance.revoked_root = revoked_root;
}

pub fn deposit<A: AssetAdapter>(
    vault: &mut VaultState,
    tree: &mut NoteTree,
    adapter: &A,
    request: &DepositRequest,
) -> Result<DepositReceipt, KernelError> {
    execute_deposit(vault, tree, adapter, request)
}

pub fn commit_public_inputs(
    pending: &mut PendingInputsAccount,
    binder: &[u8; 32],
    publics: &PublicInputs,
) -> Result<(), KernelError> {
    crate::spend_flow::commit_public_inputs(pending, binder, publics)
}

pub fn spend<V: VerifySpend>(
    context: &mut SpendContext<'_, V>,
    proof: &[u8],
) -> Result<SpendReceipt, KernelError> {
    execute_spend(context, proof)
}
