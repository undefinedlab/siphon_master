use siphon_kernel_types::KernelError;

/// Swap mux limbs 17–22 (profile-defined meaning; indices fixed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapMux {
    pub route_or_amm: [u8; 32],
    pub dst_mint: [u8; 32],
    pub route_meta: [u8; 32],
    pub min_amount_out: [u8; 32],
    pub output_precommitment: [u8; 32],
    pub dest_commitment: [u8; 32],
}

impl SwapMux {
    pub fn from_public_limbs(limbs: &[[u8; 32]; 25]) -> Self {
        Self {
            route_or_amm: limbs[17],
            dst_mint: limbs[18],
            route_meta: limbs[19],
            min_amount_out: limbs[20],
            output_precommitment: limbs[21],
            dest_commitment: limbs[22],
        }
    }

    /// Interpret min_amount_out limb as LE u64 when high bytes are zero (host helper).
    pub fn min_out_u64(&self) -> Result<u64, KernelError> {
        let b = &self.min_amount_out;
        if b[8..].iter().any(|&x| x != 0) {
            return Err(KernelError::AdapterDeltaMismatch);
        }
        let mut le = [0u8; 8];
        le.copy_from_slice(&b[0..8]);
        Ok(u64::from_le_bytes(le))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementFill {
    pub amount_out: u64,
    pub dst_mint: [u8; 32],
}

/// Port: fill a private SWAP against Jupiter-style routes.
pub trait SettlementAdapter {
    fn fill(&self, amount_in: u64, mux: &SwapMux) -> Result<SettlementFill, KernelError>;
}

/// Wrapped-SOL mint bytes helper for docs/tests.
pub struct WsolMeta;

impl WsolMeta {
    pub const MINT_ASCII_HINT: &'static str = "So11111111111111111111111111111111111111112";
}

/// Host scaffold: enforces min_out and returns min_out (no real Jupiter CPI yet).
#[derive(Default, Debug)]
pub struct JupiterSettlementAdapter {
    /// Simulated quote surplus over min_out (0 = exact min).
    pub surplus: u64,
}

impl SettlementAdapter for JupiterSettlementAdapter {
    fn fill(&self, amount_in: u64, mux: &SwapMux) -> Result<SettlementFill, KernelError> {
        if amount_in == 0 {
            return Err(KernelError::AdapterDeltaMismatch);
        }
        let min_out = mux.min_out_u64()?;
        let out = min_out.saturating_add(self.surplus);
        if out < min_out {
            return Err(KernelError::AdapterDeltaMismatch);
        }
        Ok(SettlementFill {
            amount_out: out,
            dst_mint: mux.dst_mint,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_respects_min_out() {
        let mut limbs = [[0u8; 32]; 25];
        limbs[18] = [7u8; 32];
        limbs[20][0] = 50; // min 50 LE
        let mux = SwapMux::from_public_limbs(&limbs);
        let fill = JupiterSettlementAdapter { surplus: 3 }
            .fill(100, &mux)
            .unwrap();
        assert_eq!(fill.amount_out, 53);
        assert_eq!(fill.dst_mint, [7u8; 32]);
    }
}
