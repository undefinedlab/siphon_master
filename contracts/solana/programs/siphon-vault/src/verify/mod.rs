//! VerifySpend implementations for `groth16-bn254-solana-altbn128-v1`.

mod circuit;
mod proof;
mod vk_account;

pub use circuit::{circuit_for, circuit_for_publics, SpendCircuitId};
pub use proof::Groth16ProofBytes;
pub use vk_account::{pack_vk_account, VkAccountBytes, NR_PUBLIC_INPUTS, VK_ACCOUNT_BYTES, VK_IC_LEN};

use siphon_kernel_types::{KernelError, PublicInputs, PUBLIC_WIDTH};
#[cfg(feature = "on-chain")]
use vk_account::VkAccountBytes as VkBytes;

pub trait VerifySpend {
    fn verify(
        &self,
        program_version: &[u8; 32],
        public_inputs: &PublicInputs,
        proof: &[u8],
    ) -> Result<(), KernelError>;
}

/// Closed by default — no silent accept.
#[derive(Default, Debug)]
pub struct UnconfiguredVerifier;

impl VerifySpend for UnconfiguredVerifier {
    fn verify(
        &self,
        _program_version: &[u8; 32],
        _public_inputs: &PublicInputs,
        _proof: &[u8],
    ) -> Result<(), KernelError> {
        Err(KernelError::VerifyNotConfigured)
    }
}

/// Which circuits have a verifying key registered (account / const handle).
pub trait VkRegistry {
    fn has_vk(&self, circuit: SpendCircuitId) -> bool;
    /// Optional: load packed VK account bytes for `circuit` (on-chain / host).
    fn load_vk_bytes(&self, circuit: SpendCircuitId) -> Option<&[u8]> {
        let _ = circuit;
        None
    }
}

pub const VK_SLOT_COUNT: usize = 14;

/// On-chain-shaped registry: each circuit slot identifies the account containing its VK.
#[derive(Clone, Debug, Default)]
pub struct AccountVkRegistry {
    pub accounts: [Option<[u8; 32]>; VK_SLOT_COUNT],
}

impl AccountVkRegistry {
    pub fn set(&mut self, circuit: SpendCircuitId, account: [u8; 32]) {
        self.accounts[circuit_index(circuit)] = Some(account);
    }
}

impl VkRegistry for AccountVkRegistry {
    fn has_vk(&self, circuit: SpendCircuitId) -> bool {
        self.accounts[circuit_index(circuit)].is_some()
    }
}

fn circuit_index(circuit: SpendCircuitId) -> usize {
    SpendCircuitId::ALL
        .iter()
        .position(|c| *c == circuit)
        .expect("circuit in ALL")
}

/// In-memory registry for tests and host scaffolding.
#[derive(Clone, Debug)]
pub struct MemoryVkRegistry {
    pub enabled: [bool; SpendCircuitId::ALL.len()],
    pub vk_blobs: [Option<Vec<u8>>; SpendCircuitId::ALL.len()],
}

impl Default for MemoryVkRegistry {
    fn default() -> Self {
        Self {
            enabled: [true; SpendCircuitId::ALL.len()],
            vk_blobs: std::array::from_fn(|_| None),
        }
    }
}

impl MemoryVkRegistry {
    pub fn none() -> Self {
        Self {
            enabled: [false; SpendCircuitId::ALL.len()],
            vk_blobs: std::array::from_fn(|_| None),
        }
    }

    pub fn with_vk_blob(mut self, circuit: SpendCircuitId, blob: Vec<u8>) -> Self {
        let i = circuit_index(circuit);
        self.enabled[i] = true;
        self.vk_blobs[i] = Some(blob);
        self
    }

    fn index(circuit: SpendCircuitId) -> usize {
        circuit_index(circuit)
    }
}

impl VkRegistry for MemoryVkRegistry {
    fn has_vk(&self, circuit: SpendCircuitId) -> bool {
        self.enabled[Self::index(circuit)]
    }

    fn load_vk_bytes(&self, circuit: SpendCircuitId) -> Option<&[u8]> {
        self.vk_blobs[Self::index(circuit)].as_deref()
    }
}

/// Crypto backend for pairing check (syscalls on-chain; mock/host in tests).
pub trait PairingBackend {
    fn verify_groth16(
        &self,
        circuit: SpendCircuitId,
        publics: &PublicInputs,
        proof: &Groth16ProofBytes,
        vk_bytes: Option<&[u8]>,
    ) -> Result<(), KernelError>;
}

/// Default host backend. Pairing verification is unavailable, so verification fails closed.
#[derive(Default, Debug)]
pub struct FailClosedBackend;

impl PairingBackend for FailClosedBackend {
    fn verify_groth16(
        &self,
        _circuit: SpendCircuitId,
        _publics: &PublicInputs,
        _proof: &Groth16ProofBytes,
        _vk_bytes: Option<&[u8]>,
    ) -> Result<(), KernelError> {
        Err(KernelError::VerifyFailed)
    }
}

/// Test/dev-only structural acceptance. Never compiled into production by default.
#[cfg(any(test, feature = "scaffold-verify"))]
#[derive(Default, Debug)]
pub struct StructuralAcceptBackend;

#[cfg(any(test, feature = "scaffold-verify"))]
impl PairingBackend for StructuralAcceptBackend {
    fn verify_groth16(
        &self,
        _circuit: SpendCircuitId,
        _publics: &PublicInputs,
        _proof: &Groth16ProofBytes,
        _vk_bytes: Option<&[u8]>,
    ) -> Result<(), KernelError> {
        Ok(())
    }
}

/// Reverse each 32-byte LE public limb into BE for groth16-solana.
pub fn publics_to_be_array(publics: &PublicInputs) -> [[u8; 32]; PUBLIC_WIDTH] {
    let mut out = [[0u8; 32]; PUBLIC_WIDTH];
    for (i, limb) in publics.limbs.iter().enumerate() {
        let mut be = *limb;
        be.reverse();
        out[i] = be;
    }
    out
}

/// Negate proof A Y-coordinate for Circom/snarkjs compatibility (Fq - y).
/// Must use the BN254 **base** field modulus (Fq), not the scalar field (Fr).
pub fn negate_proof_a_be(proof_a: &[u8; 64]) -> Result<[u8; 64], KernelError> {
    // Fq = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
    const FQ_BE: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
        0x5d, 0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c,
        0xfd, 0x47,
    ];
    let mut out = *proof_a;
    let y = &proof_a[32..64];
    if y.iter().all(|&b| b == 0) {
        return Ok(out);
    }
    let mut result = [0u8; 32];
    let mut borrow: i16 = 0;
    for i in (0..32).rev() {
        let diff = FQ_BE[i] as i16 - y[i] as i16 - borrow;
        if diff < 0 {
            result[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            result[i] = diff as u8;
            borrow = 0;
        }
    }
    out[32..64].copy_from_slice(&result);
    Ok(out)
}

/// `on-chain` implementation: load VK account bytes and invoke Solana alt_bn128 via groth16-solana.
#[cfg(feature = "on-chain")]
#[derive(Default, Debug)]
pub struct AltBn128SyscallBackend;

#[cfg(feature = "on-chain")]
impl PairingBackend for AltBn128SyscallBackend {
    fn verify_groth16(
        &self,
        _circuit: SpendCircuitId,
        publics: &PublicInputs,
        proof: &Groth16ProofBytes,
        vk_bytes: Option<&[u8]>,
    ) -> Result<(), KernelError> {
        use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};

        let raw = vk_bytes.ok_or(KernelError::VerifyNotConfigured)?;
        let vk = VkBytes::from_raw(raw.to_vec())?;
        let ic = vk.ic();
        let verifying_key = Groth16Verifyingkey {
            nr_pubinputs: NR_PUBLIC_INPUTS,
            vk_alpha_g1: vk.alpha_g1(),
            vk_beta_g2: vk.beta_g2(),
            vk_gamme_g2: vk.gamma_g2(),
            vk_delta_g2: vk.delta_g2(),
            vk_ic: &ic[..],
        };

        let proof_a = negate_proof_a_be(&proof.a)?;
        let proof_b = proof.b;
        let proof_c = proof.c;
        let public_inputs = publics_to_be_array(publics);

        let mut verifier = Groth16Verifier::<NR_PUBLIC_INPUTS>::new(
            &proof_a,
            &proof_b,
            &proof_c,
            &public_inputs,
            &verifying_key,
        )
        .map_err(|_| KernelError::VerifyFailed)?;

        verifier.verify().map_err(|_| KernelError::VerifyFailed)
    }
}

/// Production-shaped verifier: parse proof → route circuit → check VK → pairing backend.
#[derive(Debug)]
pub struct Groth16AltBn128Verifier<R: VkRegistry, B: PairingBackend> {
    pub registry: R,
    pub backend: B,
}

impl<R: VkRegistry, B: PairingBackend> Groth16AltBn128Verifier<R, B> {
    pub fn new(registry: R, backend: B) -> Self {
        Self { registry, backend }
    }
}

impl<R: VkRegistry, B: PairingBackend> VerifySpend for Groth16AltBn128Verifier<R, B> {
    fn verify(
        &self,
        program_version: &[u8; 32],
        public_inputs: &PublicInputs,
        proof: &[u8],
    ) -> Result<(), KernelError> {
        if public_inputs.program_version_limb() != program_version {
            return Err(KernelError::ProgramVersionMismatch);
        }
        let circuit = circuit_for_publics(public_inputs)?;
        if !self.registry.has_vk(circuit) {
            return Err(KernelError::VerifyNotConfigured);
        }
        let parsed = Groth16ProofBytes::parse(proof)?;
        let vk_bytes = self.registry.load_vk_bytes(circuit);
        self.backend
            .verify_groth16(circuit, public_inputs, &parsed, vk_bytes)
    }
}

pub type HostVerifier = Groth16AltBn128Verifier<AccountVkRegistry, FailClosedBackend>;

pub fn host_verifier(registry: AccountVkRegistry) -> HostVerifier {
    Groth16AltBn128Verifier::new(registry, FailClosedBackend)
}

/// Explicitly gated convenience alias for tests / scaffold builds.
#[cfg(any(test, feature = "scaffold-verify"))]
pub type HostScaffoldVerifier = Groth16AltBn128Verifier<MemoryVkRegistry, StructuralAcceptBackend>;

#[cfg(any(test, feature = "scaffold-verify"))]
pub fn host_scaffold_verifier() -> HostScaffoldVerifier {
    Groth16AltBn128Verifier::new(MemoryVkRegistry::default(), StructuralAcceptBackend)
}

/// Artifact id string pinned by VERIFY-DECISION.md / solana-v1 profile.
pub const VERIFY_ARTIFACT_ID: &str =
    siphon_kernel_types::verify_artifact_id::GROTH16_BN254_SOLANA_ALTBN128_V1;

#[cfg(test)]
mod tests {
    use super::*;
    use siphon_kernel_types::{SpendAction, GROTH16_PROOF_BYTES};

    fn swap_publics(version: u8) -> PublicInputs {
        let mut pi = PublicInputs::zeroed();
        pi.limbs[0][0] = SpendAction::Swap.as_u8();
        pi.limbs[1][0] = 1;
        pi.limbs[16][0] = version;
        pi
    }

    #[test]
    fn verifies_when_version_and_proof_ok() {
        let v = host_scaffold_verifier();
        let pv = {
            let mut b = [0u8; 32];
            b[0] = 4;
            b
        };
        let pi = swap_publics(4);
        v.verify(&pv, &pi, &[0u8; GROTH16_PROOF_BYTES]).unwrap();
    }

    #[test]
    fn rejects_version_mismatch() {
        let v = host_scaffold_verifier();
        let pi = swap_publics(4);
        let err = v
            .verify(&[0u8; 32], &pi, &[0u8; GROTH16_PROOF_BYTES])
            .unwrap_err();
        assert_eq!(err, KernelError::ProgramVersionMismatch);
    }

    #[test]
    fn rejects_missing_vk() {
        let v = Groth16AltBn128Verifier::new(MemoryVkRegistry::none(), StructuralAcceptBackend);
        let mut pv = [0u8; 32];
        pv[0] = 4;
        let pi = swap_publics(4);
        let err = v.verify(&pv, &pi, &[0u8; GROTH16_PROOF_BYTES]).unwrap_err();
        assert_eq!(err, KernelError::VerifyNotConfigured);
    }

    #[test]
    fn publics_endian_flip() {
        let mut pi = PublicInputs::zeroed();
        pi.limbs[0][0] = 0x01;
        pi.limbs[0][31] = 0xAB;
        let be = publics_to_be_array(&pi);
        assert_eq!(be[0][31], 0x01);
        assert_eq!(be[0][0], 0xAB);
    }

    #[test]
    fn negate_proof_a_zero_y_unchanged() {
        let a = [0u8; 64];
        assert_eq!(negate_proof_a_be(&a).unwrap(), a);
    }

    #[test]
    fn fail_closed_backend_rejects() {
        let v = Groth16AltBn128Verifier::new(MemoryVkRegistry::default(), FailClosedBackend);
        let mut pv = [0u8; 32];
        pv[0] = 4;
        let err = v
            .verify(&pv, &swap_publics(4), &[0u8; GROTH16_PROOF_BYTES])
            .unwrap_err();
        assert_eq!(err, KernelError::VerifyFailed);
    }

    #[test]
    fn pack_vk_then_registry_loads() {
        let ic = [[9u8; 64]; VK_IC_LEN];
        let vk = pack_vk_account([1u8; 64], [2u8; 128], [3u8; 128], [4u8; 128], &ic).unwrap();
        let reg = MemoryVkRegistry::none().with_vk_blob(SpendCircuitId::Withdraw1, vk.raw.clone());
        assert!(reg.has_vk(SpendCircuitId::Withdraw1));
        assert_eq!(reg.load_vk_bytes(SpendCircuitId::Withdraw1).unwrap().len(), VK_ACCOUNT_BYTES);
    }
}
