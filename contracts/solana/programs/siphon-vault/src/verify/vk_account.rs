//! On-chain verifying-key account layout for groth16-solana (25 public inputs).
//!
//! Wire format (little-endian header, big-endian curve points as groth16-solana expects):
//! ```text
//! [0..8]     nr_pubinputs: u64 (= 25)
//! [8..72]    vk_alpha_g1 (64)
//! [72..200]  vk_beta_g2 (128)
//! [200..328] vk_gamma_g2 (128)
//! [328..456] vk_delta_g2 (128)
//! [456..]    vk_ic[0..26] each 64 bytes (IC0 + 25 inputs)
//! ```

use siphon_kernel_types::KernelError;

pub const NR_PUBLIC_INPUTS: usize = 25;
pub const VK_IC_LEN: usize = NR_PUBLIC_INPUTS + 1;
pub const VK_ACCOUNT_BYTES: usize = 8 + 64 + 128 + 128 + 128 + VK_IC_LEN * 64;

/// Owned VK blob suitable for Account data / host tests.
#[derive(Clone, Debug)]
pub struct VkAccountBytes {
    pub raw: Vec<u8>,
}

impl VkAccountBytes {
    pub fn from_raw(raw: Vec<u8>) -> Result<Self, KernelError> {
        if raw.len() < VK_ACCOUNT_BYTES {
            return Err(KernelError::VerifyNotConfigured);
        }
        let nr = u64::from_le_bytes(raw[0..8].try_into().unwrap());
        if nr as usize != NR_PUBLIC_INPUTS {
            return Err(KernelError::VerifyNotConfigured);
        }
        Ok(Self { raw })
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.raw[..VK_ACCOUNT_BYTES]
    }

    pub fn alpha_g1(&self) -> [u8; 64] {
        let mut out = [0u8; 64];
        out.copy_from_slice(&self.raw[8..72]);
        out
    }

    pub fn beta_g2(&self) -> [u8; 128] {
        let mut out = [0u8; 128];
        out.copy_from_slice(&self.raw[72..200]);
        out
    }

    pub fn gamma_g2(&self) -> [u8; 128] {
        let mut out = [0u8; 128];
        out.copy_from_slice(&self.raw[200..328]);
        out
    }

    pub fn delta_g2(&self) -> [u8; 128] {
        let mut out = [0u8; 128];
        out.copy_from_slice(&self.raw[328..456]);
        out
    }

    pub fn ic(&self) -> [[u8; 64]; VK_IC_LEN] {
        let mut out = [[0u8; 64]; VK_IC_LEN];
        let base = 456;
        for (i, slot) in out.iter_mut().enumerate() {
            let start = base + i * 64;
            slot.copy_from_slice(&self.raw[start..start + 64]);
        }
        out
    }
}

/// Build a VK account blob from groth16-solana point arrays (already BE-encoded).
pub fn pack_vk_account(
    alpha_g1: [u8; 64],
    beta_g2: [u8; 128],
    gamma_g2: [u8; 128],
    delta_g2: [u8; 128],
    ic: &[[u8; 64]],
) -> Result<VkAccountBytes, KernelError> {
    if ic.len() != VK_IC_LEN {
        return Err(KernelError::VerifyNotConfigured);
    }
    let mut raw = vec![0u8; VK_ACCOUNT_BYTES];
    raw[0..8].copy_from_slice(&(NR_PUBLIC_INPUTS as u64).to_le_bytes());
    raw[8..72].copy_from_slice(&alpha_g1);
    raw[72..200].copy_from_slice(&beta_g2);
    raw[200..328].copy_from_slice(&gamma_g2);
    raw[328..456].copy_from_slice(&delta_g2);
    for (i, point) in ic.iter().enumerate() {
        let start = 456 + i * 64;
        raw[start..start + 64].copy_from_slice(point);
    }
    VkAccountBytes::from_raw(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_roundtrip_size() {
        let ic = [[1u8; 64]; VK_IC_LEN];
        let vk = pack_vk_account([2u8; 64], [3u8; 128], [4u8; 128], [5u8; 128], &ic).unwrap();
        assert_eq!(vk.as_slice().len(), VK_ACCOUNT_BYTES);
        assert_eq!(vk.alpha_g1()[0], 2);
        assert_eq!(vk.ic()[0][0], 1);
    }
}
