use siphon_vault::adapters::{JupiterSettlementAdapter, SplAssetAdapter};
use siphon_vault::kernel::{
    KernelError, PublicInputs, SpendAction, GROTH16_PROOF_BYTES, MAX_INPUTS, NULLIFIER_START,
};
use siphon_vault::note_tree::NoteTree;
use siphon_vault::nullifiers::NullifierSet;
use siphon_vault::pending_inputs::PendingInputsAccount;
use siphon_vault::spend_flow::{commit_public_inputs, execute_spend, SpendContext};
use siphon_vault::state::{ComplianceState, VaultState};
use siphon_vault::verify::{host_verifier, AccountVkRegistry, SpendCircuitId, VerifySpend};

#[derive(Debug)]
struct AcceptForInvariantTests;

impl VerifySpend for AcceptForInvariantTests {
    fn verify(
        &self,
        _program_version: &[u8; 32],
        _public_inputs: &PublicInputs,
        _proof: &[u8],
    ) -> Result<(), KernelError> {
        Ok(())
    }
}

fn merge_publics(root: [u8; 32], admitted: [u8; 32], revoked: [u8; 32]) -> PublicInputs {
    let mut pi = PublicInputs::zeroed();
    pi.limbs[0][0] = SpendAction::Merge.as_u8();
    pi.limbs[1][0] = 2;
    pi.limbs[2] = root;
    pi.limbs[3] = admitted;
    pi.limbs[4] = revoked;
    pi.limbs[7][0] = 9;
    pi.limbs[NULLIFIER_START][0] = 1;
    pi.limbs[NULLIFIER_START + 1][0] = 2;
    pi.limbs[16][0] = 4;
    pi
}

fn execute_merge(pi: &PublicInputs) -> Result<(), KernelError> {
    let root = pi.limbs[2];
    let compliance = ComplianceState {
        admitted_root: pi.limbs[3],
        revoked_root: pi.limbs[4],
    };
    let mut vault = VaultState {
        vault_scope_id: [0u8; 32],
        program_version: pi.limbs[16],
        deposit_nonce: 0,
        state_root: root,
        deposits_paused: false,
        action_paused_mask: 0,
    };
    let mut pending = PendingInputsAccount::default();
    let binder = [8u8; 32];
    commit_public_inputs(&mut pending, &binder, pi)?;
    let mut nullifiers = NullifierSet::default();
    let mut tree = NoteTree::new(32);
    let asset = SplAssetAdapter::permissive();
    let settlement = JupiterSettlementAdapter::default();
    let verifier = AcceptForInvariantTests;
    let known_roots = [root];
    let mut context = SpendContext {
        vault: &mut vault,
        compliance: &compliance,
        pending: &mut pending,
        nullifiers: &mut nullifiers,
        verifier: &verifier,
        binder,
        raw_payee: [0u8; 32],
        split_commitments: [[0u8; 32]; 8],
        note_tree: &mut tree,
        asset_adapter: &asset,
        settlement_adapter: &settlement,
        known_state_roots: &known_roots,
    };
    execute_spend(&mut context, &[]).map(|_| ())
}

#[test]
fn merge_rejects_every_nonzero_unused_mux_limb() {
    let base = merge_publics([1u8; 32], [2u8; 32], [3u8; 32]);
    execute_merge(&base).expect("zeroed MERGE mux must be accepted");

    for limb_index in 17..25 {
        for sample in [1u8, 0x7f, 0xff] {
            let mut candidate = base.clone();
            candidate.limbs[limb_index][limb_index % 32] = sample;
            assert_eq!(
                execute_merge(&candidate),
                Err(KernelError::MergePrivacyViolation),
                "limb {limb_index} with sample {sample:#x} was not rejected"
            );
        }
    }
}

#[test]
fn rejects_every_nonzero_nullifier_padding_slot() {
    let base = merge_publics([1u8; 32], [2u8; 32], [3u8; 32]);

    for nullifier_index in 2..MAX_INPUTS {
        for sample in [1u8, 0x7f, 0xff] {
            let mut candidate = base.clone();
            candidate.limbs[NULLIFIER_START + nullifier_index][nullifier_index] = sample;
            assert_eq!(
                execute_merge(&candidate),
                Err(KernelError::InvalidInputCount),
                "padding nullifier {nullifier_index} was not rejected"
            );
        }
    }
}

#[test]
#[cfg(not(feature = "scaffold-verify"))]
fn default_host_verifier_fails_closed_without_scaffold_feature() {
    let pi = merge_publics([1u8; 32], [2u8; 32], [3u8; 32]);
    let mut registry = AccountVkRegistry::default();
    registry.set(SpendCircuitId::Merge2, [7u8; 32]);
    let verifier = host_verifier(registry);

    assert_eq!(
        verifier.verify(pi.program_version_limb(), &pi, &[0u8; GROTH16_PROOF_BYTES]),
        Err(KernelError::VerifyFailed)
    );
}
