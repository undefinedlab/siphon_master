//! Host-side spend orchestration — same checklist as on-chain kernel will run.

use siphon_kernel_types::{
    KernelChecklist, KernelError, PublicInputs, SpendAction, SpendPhase, MAX_INPUTS,
};

use crate::adapters::{AssetAdapter, SettlementAdapter, SwapMux};
use crate::note_tree::NoteTree;
use crate::nullifiers::NullifierSet;
use crate::pending_inputs::PendingInputsAccount;
use crate::poseidon::{field_from_le_bytes, field_to_le_bytes, hash2};
use crate::profile::{PayeeCodec, SolanaPayeeCodec};
use crate::state::{ComplianceState, VaultState};
use crate::verify::VerifySpend;

/// Result of a successful logical spend (before asset/settlement adapters).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpendReceipt {
    pub action: SpendAction,
    pub input_count: u8,
    pub phases: Vec<SpendPhase>,
}

pub struct SpendContext<'a, V: VerifySpend> {
    pub vault: &'a mut VaultState,
    pub compliance: &'a ComplianceState,
    pub pending: &'a mut PendingInputsAccount,
    pub nullifiers: &'a mut NullifierSet,
    pub verifier: &'a V,
    pub binder: [u8; 32],
    pub raw_payee: [u8; 32],
    pub split_commitments: [[u8; 32]; 8],
    pub note_tree: &'a mut NoteTree,
    pub asset_adapter: &'a dyn AssetAdapter,
    pub settlement_adapter: &'a dyn SettlementAdapter,
    /// Known historical state roots (include current).
    pub known_state_roots: &'a [[u8; 32]],
}

/// Full private-spend path using pending-inputs PDA + VerifySpend port.
pub fn execute_spend<V: VerifySpend>(
    ctx: &mut SpendContext<'_, V>,
    proof: &[u8],
) -> Result<SpendReceipt, KernelError> {
    let mut phases = Vec::with_capacity(6);

    // Consume publics from PDA (tx-size pattern).
    let pi = ctx.pending.consume(&ctx.binder)?;
    let action = pi.action()?;
    let input_count = pi.input_count()?;

    if ctx.vault.action_paused_mask & (1 << action.as_u8()) != 0 {
        return Err(KernelError::ActionRejected);
    }

    // 1. Verify
    phases.push(SpendPhase::VerifyArtifact);
    ctx.verifier
        .verify(&ctx.vault.program_version, &pi, proof)?;

    // 2. Program version (also checked inside verifier; re-assert for checklist clarity)
    phases.push(SpendPhase::CheckProgramVersion);
    if pi.program_version_limb() != &ctx.vault.program_version {
        return Err(KernelError::ProgramVersionMismatch);
    }

    // 3. State root — limb 2 is stateRoot per PROTOCOL public layout
    phases.push(SpendPhase::CheckStateRoot);
    let state_root = &pi.limbs[2];
    if !ctx.known_state_roots.iter().any(|r| r == state_root) {
        return Err(KernelError::UnknownStateRoot);
    }

    // 4. Compliance roots — limbs 3/4 admitted/revoked for private spend
    phases.push(SpendPhase::CheckComplianceRoots);
    KernelChecklist::assert_private_out_label_zero(pi.out_label_is_zero())?;
    if action == SpendAction::Merge {
        KernelChecklist::assert_merge_policy(action, pi.out_label_is_zero())?;
        // MERGE discloses neither an amount/asset delta nor adapter-specific mux data.
        // Keep these guest-constrained zeros fail-closed at the runtime boundary too.
        if pi.limbs[5] != [0u8; 32]
            || pi.limbs[6] != [0u8; 32]
            || pi.limbs[17..].iter().any(|limb| *limb != [0u8; 32])
        {
            return Err(KernelError::MergePrivacyViolation);
        }
    }
    // RAGEQUIT is policy-sensitive too: the proof's branch is bound to these exact roots.
    if pi.limbs[3] != ctx.compliance.admitted_root || pi.limbs[4] != ctx.compliance.revoked_root {
        return Err(KernelError::ComplianceRootMismatch);
    }

    // padding slots must be zero — soft check
    for i in input_count as usize..MAX_INPUTS {
        let n = pi.nullifier(i).unwrap();
        if n != &[0u8; 32] {
            return Err(KernelError::InvalidInputCount);
        }
    }

    phases.push(SpendPhase::BurnNullifiers);
    phases.push(SpendPhase::DispatchAction);
    // Validate external action bindings before mutating nullifier/tree state.
    let inserts = finalize_action(ctx, &pi, action)?;

    // Burn only after every adapter/binding check succeeds. Solana instruction rollback makes
    // subsequent tree updates atomic on-chain; host inserts below are deterministic.
    for i in 0..input_count as usize {
        let n = pi.nullifier(i).ok_or(KernelError::InvalidInputCount)?;
        ctx.nullifiers.burn(n)?;
    }
    for commitment in inserts {
        ctx.note_tree.insert(commitment)?;
    }
    ctx.vault.state_root = ctx.note_tree.root;

    Ok(SpendReceipt {
        action,
        input_count,
        phases,
    })
}

fn limb_u64(limb: &[u8; 32]) -> Result<u64, KernelError> {
    if limb[8..].iter().any(|b| *b != 0) {
        return Err(KernelError::AdapterDeltaMismatch);
    }
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&limb[..8]);
    Ok(u64::from_le_bytes(bytes))
}

fn check_payee(expected: &[u8; 32], raw_payee: &[u8; 32]) -> Result<(), KernelError> {
    if SolanaPayeeCodec.payee_id(raw_payee)? != *expected {
        return Err(KernelError::PayeeMismatch);
    }
    Ok(())
}

fn push_if_nonzero(out: &mut Vec<[u8; 32]>, commitment: [u8; 32]) {
    if commitment != [0u8; 32] {
        out.push(commitment);
    }
}

fn split_root(commitments: &[[u8; 32]; 8]) -> Result<[u8; 32], KernelError> {
    let mut level: Vec<_> = commitments.iter().map(field_from_le_bytes).collect();
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|pair| hash2(pair[0], pair[1]))
            .collect::<Result<Vec<_>, _>>()?;
    }
    Ok(field_to_le_bytes(&level[0]))
}

fn finalize_action<V: VerifySpend>(
    ctx: &mut SpendContext<'_, V>,
    pi: &PublicInputs,
    action: SpendAction,
) -> Result<Vec<[u8; 32]>, KernelError> {
    let mut inserts = Vec::with_capacity(8);
    match action {
        SpendAction::Withdraw => {
            check_payee(&pi.limbs[15], &ctx.raw_payee)?;
            ctx.asset_adapter
                .push(&pi.limbs[17], limb_u64(&pi.limbs[5])?)?;
            push_if_nonzero(&mut inserts, pi.limbs[7]);
        }
        SpendAction::Merge => push_if_nonzero(&mut inserts, pi.limbs[7]),
        SpendAction::Swap => {
            let mux = SwapMux::from_public_limbs(&pi.limbs);
            ctx.settlement_adapter.fill(limb_u64(&pi.limbs[5])?, &mux)?;
            push_if_nonzero(&mut inserts, pi.limbs[7]);
            push_if_nonzero(&mut inserts, mux.dest_commitment);
        }
        SpendAction::Split => {
            if split_root(&ctx.split_commitments)? != pi.limbs[17] {
                return Err(KernelError::AdapterDeltaMismatch);
            }
            for commitment in ctx.split_commitments {
                push_if_nonzero(&mut inserts, commitment);
            }
        }
        SpendAction::Ragequit => {
            // Ragequit binds payee in mux[0], not public[15].
            check_payee(&pi.limbs[17], &ctx.raw_payee)?;
            ctx.asset_adapter
                .push(&pi.limbs[18], limb_u64(&pi.limbs[5])?)?;
        }
    }
    Ok(inserts)
}

/// Tx1 helper: commit publics into pending account.
pub fn commit_public_inputs(
    pending: &mut PendingInputsAccount,
    binder: &[u8; 32],
    publics: &PublicInputs,
) -> Result<(), KernelError> {
    pending.commit(binder, publics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{JupiterSettlementAdapter, SplAssetAdapter};
    use crate::verify::host_scaffold_verifier;
    use siphon_kernel_types::GROTH16_PROOF_BYTES;

    fn setup_vault(version: u8, state_root: [u8; 32]) -> VaultState {
        let mut program_version = [0u8; 32];
        program_version[0] = version;
        VaultState {
            vault_scope_id: [9u8; 32],
            program_version,
            deposit_nonce: 0,
            state_root,
            deposits_paused: false,
            action_paused_mask: 0,
        }
    }

    fn swap_pi(version: u8, state_root: [u8; 32], adm: [u8; 32], rev: [u8; 32]) -> PublicInputs {
        let mut pi = PublicInputs::zeroed();
        pi.limbs[0][0] = SpendAction::Swap.as_u8();
        pi.limbs[1][0] = 1;
        pi.limbs[2] = state_root;
        pi.limbs[3] = adm;
        pi.limbs[4] = rev;
        pi.limbs[5][0] = 10;
        pi.limbs[9] = [3u8; 32]; // nullifier
        pi.limbs[16][0] = version;
        pi.limbs[20][0] = 1;
        pi
    }

    #[test]
    fn end_to_end_commit_then_spend() {
        let root = [1u8; 32];
        let adm = [2u8; 32];
        let rev = [4u8; 32];
        let mut vault = setup_vault(4, root);
        let compliance = ComplianceState {
            admitted_root: adm,
            revoked_root: rev,
        };
        let mut pending = PendingInputsAccount::default();
        let mut nullifiers = NullifierSet::default();
        let verifier = host_scaffold_verifier();
        let known = [root];
        let mut tree = NoteTree::new(32);
        let asset = SplAssetAdapter::permissive();
        let settlement = JupiterSettlementAdapter::default();

        let pi = swap_pi(4, root, adm, rev);
        commit_public_inputs(&mut pending, &[8u8; 32], &pi).unwrap();

        let mut ctx = SpendContext {
            vault: &mut vault,
            compliance: &compliance,
            pending: &mut pending,
            nullifiers: &mut nullifiers,
            verifier: &verifier,
            binder: [8u8; 32],
            raw_payee: [0u8; 32],
            split_commitments: [[0u8; 32]; 8],
            note_tree: &mut tree,
            asset_adapter: &asset,
            settlement_adapter: &settlement,
            known_state_roots: &known,
        };
        let receipt = execute_spend(&mut ctx, &[0u8; GROTH16_PROOF_BYTES]).unwrap();
        assert_eq!(receipt.action, SpendAction::Swap);
        assert_eq!(receipt.phases[0], SpendPhase::VerifyArtifact);
        assert!(nullifiers.contains(&[3u8; 32]));
        assert!(!pending.is_committed());
    }

    #[test]
    fn rejects_spend_without_commit() {
        let root = [1u8; 32];
        let mut vault = setup_vault(4, root);
        let compliance = ComplianceState {
            admitted_root: [2u8; 32],
            revoked_root: [4u8; 32],
        };
        let mut pending = PendingInputsAccount::default();
        let mut nullifiers = NullifierSet::default();
        let verifier = host_scaffold_verifier();
        let known = [root];
        let mut tree = NoteTree::new(32);
        let asset = SplAssetAdapter::permissive();
        let settlement = JupiterSettlementAdapter::default();
        let mut ctx = SpendContext {
            vault: &mut vault,
            compliance: &compliance,
            pending: &mut pending,
            nullifiers: &mut nullifiers,
            verifier: &verifier,
            binder: [8u8; 32],
            raw_payee: [0u8; 32],
            split_commitments: [[0u8; 32]; 8],
            note_tree: &mut tree,
            asset_adapter: &asset,
            settlement_adapter: &settlement,
            known_state_roots: &known,
        };
        let err = execute_spend(&mut ctx, &[0u8; GROTH16_PROOF_BYTES]).unwrap_err();
        assert_eq!(err, KernelError::PendingInputsMissing);
    }

    #[test]
    fn rejects_compliance_mismatch() {
        let root = [1u8; 32];
        let adm = [2u8; 32];
        let rev = [4u8; 32];
        let mut vault = setup_vault(4, root);
        let compliance = ComplianceState {
            admitted_root: adm,
            revoked_root: rev,
        };
        let mut pending = PendingInputsAccount::default();
        let mut nullifiers = NullifierSet::default();
        let verifier = host_scaffold_verifier();
        let known = [root];
        let mut tree = NoteTree::new(32);
        let asset = SplAssetAdapter::permissive();
        let settlement = JupiterSettlementAdapter::default();
        let pi = swap_pi(4, root, [9u8; 32], rev); // wrong admitted
        commit_public_inputs(&mut pending, &[8u8; 32], &pi).unwrap();
        let mut ctx = SpendContext {
            vault: &mut vault,
            compliance: &compliance,
            pending: &mut pending,
            nullifiers: &mut nullifiers,
            verifier: &verifier,
            binder: [8u8; 32],
            raw_payee: [0u8; 32],
            split_commitments: [[0u8; 32]; 8],
            note_tree: &mut tree,
            asset_adapter: &asset,
            settlement_adapter: &settlement,
            known_state_roots: &known,
        };
        let err = execute_spend(&mut ctx, &[0u8; GROTH16_PROOF_BYTES]).unwrap_err();
        assert_eq!(err, KernelError::ComplianceRootMismatch);
    }

    #[test]
    fn rejects_double_spend_nullifier() {
        let root = [1u8; 32];
        let adm = [2u8; 32];
        let rev = [4u8; 32];
        let mut vault = setup_vault(4, root);
        let compliance = ComplianceState {
            admitted_root: adm,
            revoked_root: rev,
        };
        let verifier = host_scaffold_verifier();
        let known = [root];
        let mut nullifiers = NullifierSet::default();
        let mut tree = NoteTree::new(32);
        let asset = SplAssetAdapter::permissive();
        let settlement = JupiterSettlementAdapter::default();

        for round in 0..2 {
            let mut pending = PendingInputsAccount::default();
            let pi = swap_pi(4, root, adm, rev);
            commit_public_inputs(&mut pending, &[8u8; 32], &pi).unwrap();
            let mut ctx = SpendContext {
                vault: &mut vault,
                compliance: &compliance,
                pending: &mut pending,
                nullifiers: &mut nullifiers,
                verifier: &verifier,
                binder: [8u8; 32],
                raw_payee: [0u8; 32],
                split_commitments: [[0u8; 32]; 8],
                note_tree: &mut tree,
                asset_adapter: &asset,
                settlement_adapter: &settlement,
                known_state_roots: &known,
            };
            let res = execute_spend(&mut ctx, &[0u8; GROTH16_PROOF_BYTES]);
            if round == 0 {
                res.unwrap();
            } else {
                assert_eq!(res.unwrap_err(), KernelError::NullifierSpent);
            }
        }
    }
}
