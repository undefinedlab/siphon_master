use crate::action::SpendAction;
use crate::error::KernelError;

/// Width of the normative public input vector (BN254 limbs).
pub const PUBLIC_WIDTH: usize = 25;

pub const ACTION_LIMB: usize = 0;
pub const INPUT_COUNT_LIMB: usize = 1;
pub const OUT_LABEL_LIMB: usize = 8;
pub const NULLIFIER_START: usize = 9;
pub const MAX_INPUTS: usize = 6;
pub const PROGRAM_VERSION_LIMB: usize = 16;

/// Uncompressed Groth16 wire size used by Solana spend txs (A||B||C).
pub const GROTH16_PROOF_BYTES: usize = 256;

/// Fixed-width public inputs. Values are little-endian field encodings as `u8[32]`
/// so this crate stays free of `ark-ff` / chain SDKs. Runtimes convert to native field types.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicInputs {
    pub limbs: [[u8; 32]; PUBLIC_WIDTH],
}

impl PublicInputs {
    pub fn zeroed() -> Self {
        Self {
            limbs: [[0u8; 32]; PUBLIC_WIDTH],
        }
    }

    pub fn from_limbs(limbs: [[u8; 32]; PUBLIC_WIDTH]) -> Self {
        Self { limbs }
    }

    /// Pack 25 limbs into a contiguous 800-byte buffer (LE field bytes).
    pub fn to_bytes(&self) -> [u8; PUBLIC_WIDTH * 32] {
        let mut out = [0u8; PUBLIC_WIDTH * 32];
        for (i, limb) in self.limbs.iter().enumerate() {
            out[i * 32..(i + 1) * 32].copy_from_slice(limb);
        }
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, KernelError> {
        if bytes.len() != PUBLIC_WIDTH * 32 {
            return Err(KernelError::PendingInputsBadLayout);
        }
        let mut limbs = [[0u8; 32]; PUBLIC_WIDTH];
        for (i, limb) in limbs.iter_mut().enumerate() {
            limb.copy_from_slice(&bytes[i * 32..(i + 1) * 32]);
        }
        Ok(Self { limbs })
    }

    pub fn program_version_limb(&self) -> &[u8; 32] {
        &self.limbs[PROGRAM_VERSION_LIMB]
    }

    fn small_u8(limb: &[u8; 32]) -> Result<u8, KernelError> {
        if limb[1..].iter().any(|&b| b != 0) {
            return Err(KernelError::InvalidActionLimb);
        }
        Ok(limb[0])
    }

    pub fn action(&self) -> Result<SpendAction, KernelError> {
        let v = Self::small_u8(&self.limbs[ACTION_LIMB])?;
        SpendAction::from_u8(v).ok_or(KernelError::ActionRejected)
    }

    pub fn input_count(&self) -> Result<u8, KernelError> {
        let v = Self::small_u8(&self.limbs[INPUT_COUNT_LIMB])
            .map_err(|_| KernelError::InvalidInputCount)?;
        if v == 0 || v as usize > MAX_INPUTS {
            return Err(KernelError::InvalidInputCount);
        }
        Ok(v)
    }

    pub fn out_label_is_zero(&self) -> bool {
        self.limbs[OUT_LABEL_LIMB] == [0u8; 32]
    }

    pub fn nullifier(&self, i: usize) -> Option<&[u8; 32]> {
        if i >= MAX_INPUTS {
            return None;
        }
        Some(&self.limbs[NULLIFIER_START + i])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_bytes() {
        let mut pi = PublicInputs::zeroed();
        pi.limbs[0][0] = 2;
        pi.limbs[1][0] = 1;
        let bytes = pi.to_bytes();
        let back = PublicInputs::from_bytes(&bytes).unwrap();
        assert_eq!(back.action().unwrap(), SpendAction::Swap);
        assert_eq!(back.input_count().unwrap(), 1);
    }
}
