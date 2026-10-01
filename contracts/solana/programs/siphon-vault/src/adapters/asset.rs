use siphon_kernel_types::KernelError;
use std::collections::HashMap;

/// Measured token movement (prevents fake amount deposits / drains).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MeasuredDelta {
    pub amount: u64,
}

/// Mint metadata known to the vault (allow-list).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SplTokenMeta {
    pub mint: [u8; 32],
    pub decimals: u8,
    pub allowed: bool,
}

/// Port: pull/push SPL (or wrapped-SOL) assets.
pub trait AssetAdapter {
    fn is_allowed(&self, mint: &[u8; 32]) -> bool;
    fn pull(&self, mint: &[u8; 32], amount: u64) -> Result<MeasuredDelta, KernelError>;
    fn push(&self, mint: &[u8; 32], amount: u64) -> Result<MeasuredDelta, KernelError>;
}

/// Host / scaffold adapter with allow-listed mints and in-memory balances.
#[derive(Debug, Clone)]
pub struct SplAssetAdapter {
    pub allowed: HashMap<[u8; 32], SplTokenMeta>,
    /// Simulated vault token-account balances per mint.
    pub balances: HashMap<[u8; 32], u64>,
    /// When true, any mint is accepted (unit tests / early scaffold).
    pub permissive: bool,
}

impl Default for SplAssetAdapter {
    fn default() -> Self {
        Self::permissive()
    }
}

impl SplAssetAdapter {
    /// Test / host scaffold: any mint allowed.
    pub fn permissive() -> Self {
        Self {
            allowed: HashMap::new(),
            balances: HashMap::new(),
            permissive: true,
        }
    }

    pub fn allowlisted(mints: impl IntoIterator<Item = SplTokenMeta>) -> Self {
        let mut allowed = HashMap::new();
        let mut balances = HashMap::new();
        for m in mints {
            balances.insert(m.mint, 0);
            allowed.insert(m.mint, m);
        }
        Self {
            allowed,
            balances,
            permissive: false,
        }
    }

    pub fn with_balance(mut self, mint: [u8; 32], amount: u64) -> Self {
        self.balances.insert(mint, amount);
        self
    }
}

impl AssetAdapter for SplAssetAdapter {
    fn is_allowed(&self, mint: &[u8; 32]) -> bool {
        if self.permissive {
            return true;
        }
        self.allowed.get(mint).map(|m| m.allowed).unwrap_or(false)
    }

    fn pull(&self, mint: &[u8; 32], amount: u64) -> Result<MeasuredDelta, KernelError> {
        if !self.is_allowed(mint) || amount == 0 {
            return Err(KernelError::AdapterDeltaMismatch);
        }
        Ok(MeasuredDelta { amount })
    }

    fn push(&self, mint: &[u8; 32], amount: u64) -> Result<MeasuredDelta, KernelError> {
        if !self.is_allowed(mint) {
            return Err(KernelError::AdapterDeltaMismatch);
        }
        if self.permissive {
            return Ok(MeasuredDelta { amount });
        }
        let bal = self.balances.get(mint).copied().unwrap_or(0);
        if bal < amount {
            return Err(KernelError::AdapterDeltaMismatch);
        }
        Ok(MeasuredDelta { amount })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_mint_when_allowlisted() {
        let a = SplAssetAdapter::allowlisted([]);
        assert!(a.pull(&[1u8; 32], 1).is_err());
    }
}
