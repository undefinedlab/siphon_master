//! Groth16 proof parsing for Solana wire format (256-byte A||B||C).

use siphon_kernel_types::{KernelError, GROTH16_PROOF_BYTES};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Groth16ProofBytes {
    pub a: [u8; 64],
    pub b: [u8; 128],
    pub c: [u8; 64],
}

impl Groth16ProofBytes {
    pub fn parse(proof: &[u8]) -> Result<Self, KernelError> {
        if proof.len() != GROTH16_PROOF_BYTES {
            return Err(KernelError::InvalidProofLength);
        }
        let mut a = [0u8; 64];
        let mut b = [0u8; 128];
        let mut c = [0u8; 64];
        a.copy_from_slice(&proof[0..64]);
        b.copy_from_slice(&proof[64..192]);
        c.copy_from_slice(&proof[192..256]);
        Ok(Self { a, b, c })
    }

    pub fn to_bytes(&self) -> [u8; GROTH16_PROOF_BYTES] {
        let mut out = [0u8; GROTH16_PROOF_BYTES];
        out[0..64].copy_from_slice(&self.a);
        out[64..192].copy_from_slice(&self.b);
        out[192..256].copy_from_slice(&self.c);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_roundtrip() {
        let mut raw = [0u8; GROTH16_PROOF_BYTES];
        raw[0] = 1;
        raw[64] = 2;
        raw[192] = 3;
        let p = Groth16ProofBytes::parse(&raw).unwrap();
        assert_eq!(p.a[0], 1);
        assert_eq!(p.b[0], 2);
        assert_eq!(p.c[0], 3);
        assert_eq!(p.to_bytes(), raw);
    }

    #[test]
    fn bad_len() {
        assert!(Groth16ProofBytes::parse(&[0u8; 10]).is_err());
    }
}
