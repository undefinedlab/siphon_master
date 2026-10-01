//! Groth16 verify helpers for groth16-solana (25 public inputs).
//!
//! VK layout (must match host `vk_account.rs`):
//! ```text
//! [0..8]     nr_pubinputs: u64 LE (= 25)
//! [8..72]    alpha_g1 64 BE
//! [72..200]  beta_g2 128
//! [200..328] gamma_g2 128
//! [328..456] delta_g2 128
//! [456..]    IC[26] * 64
//! ```

use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};

pub const NR_PUBLIC_INPUTS: usize = 25;
pub const VK_IC_LEN: usize = NR_PUBLIC_INPUTS + 1;
/// Packed verifying-key account size (nr header + points + 26 IC).
pub const VK_ACCOUNT_BYTES: usize = 8 + 64 + 128 + 128 + 128 + VK_IC_LEN * 64; // 2120
pub const GROTH16_PROOF_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyError {
    BadVkLayout,
    /// Groth16Verifier::new rejected proof/VK shape.
    VerifierInitFailed,
    /// prepare_inputs failed (field size / G1 mul-add).
    PrepareFailed,
    /// Pairing check returned false.
    PairingFailed,
    /// Legacy catch-all (kept for call sites).
    VerifyFailed,
}

/// Reverse each LE public limb to BE for groth16-solana.
pub fn publics_le_to_be(publics: &[[u8; 32]; NR_PUBLIC_INPUTS]) -> [[u8; 32]; NR_PUBLIC_INPUTS] {
    let mut out = [[0u8; 32]; NR_PUBLIC_INPUTS];
    for (i, limb) in publics.iter().enumerate() {
        let mut be = *limb;
        be.reverse();
        out[i] = be;
    }
    out
}

/// Negate proof A Y-coordinate for Circom/snarkjs compatibility (Fq - y).
/// Must use the BN254 **base** field modulus (Fq), not the scalar field (Fr).
pub fn negate_proof_a_be(proof_a: &[u8; 64]) -> [u8; 64] {
    // Fq = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
    const FQ_BE: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
        0x5d, 0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c,
        0xfd, 0x47,
    ];
    let mut out = *proof_a;
    let y = &proof_a[32..64];
    if y.iter().all(|&b| b == 0) {
        return out;
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
    out
}

/// Verify Circom Groth16 proof against packed VK account bytes and LE public limbs.
pub fn verify_proof(
    vk_raw: &[u8],
    proof: &[u8; GROTH16_PROOF_BYTES],
    publics_le: &[[u8; 32]; NR_PUBLIC_INPUTS],
) -> Result<(), VerifyError> {
    if vk_raw.len() < VK_ACCOUNT_BYTES {
        return Err(VerifyError::BadVkLayout);
    }
    let nr = u64::from_le_bytes(vk_raw[0..8].try_into().unwrap());
    if nr as usize != NR_PUBLIC_INPUTS {
        return Err(VerifyError::BadVkLayout);
    }

    let mut alpha = [0u8; 64];
    alpha.copy_from_slice(&vk_raw[8..72]);
    let mut beta = [0u8; 128];
    beta.copy_from_slice(&vk_raw[72..200]);
    let mut gamma = [0u8; 128];
    gamma.copy_from_slice(&vk_raw[200..328]);
    let mut delta = [0u8; 128];
    delta.copy_from_slice(&vk_raw[328..456]);

    let mut ic = [[0u8; 64]; VK_IC_LEN];
    for (i, slot) in ic.iter_mut().enumerate() {
        let start = 456 + i * 64;
        slot.copy_from_slice(&vk_raw[start..start + 64]);
    }

    let verifying_key = Groth16Verifyingkey {
        nr_pubinputs: NR_PUBLIC_INPUTS,
        vk_alpha_g1: alpha,
        vk_beta_g2: beta,
        vk_gamme_g2: gamma,
        vk_delta_g2: delta,
        vk_ic: &ic[..],
    };

    let mut proof_a = [0u8; 64];
    let mut proof_b = [0u8; 128];
    let mut proof_c = [0u8; 64];
    proof_a.copy_from_slice(&proof[0..64]);
    proof_b.copy_from_slice(&proof[64..192]);
    proof_c.copy_from_slice(&proof[192..256]);
    let proof_a = negate_proof_a_be(&proof_a);
    let public_inputs = publics_le_to_be(publics_le);

    let mut verifier = Groth16Verifier::<NR_PUBLIC_INPUTS>::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &public_inputs,
        &verifying_key,
    )
    .map_err(|_| VerifyError::VerifierInitFailed)?;

    verifier
        .prepare_inputs::<true>()
        .map_err(|_| VerifyError::PrepareFailed)?;
    // verify() re-prepares then pairs; prepare already succeeded so a failure here is pairing.
    verifier.verify().map_err(|_| VerifyError::PairingFailed)
}
