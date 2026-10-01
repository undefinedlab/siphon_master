//! Pending public inputs account — solves 1232-byte tx limit for 25 limbs.
//!
//! Layout (versioned):
//! ```text
//! [0]     version: 0 = empty/consumed, 1 = committed
//! [1..33] owner / commitment tag (32 bytes) — optional binder
//! [33..833] publicInputs (25 × 32)
//! ```

use siphon_kernel_types::{KernelError, PublicInputs, PUBLIC_WIDTH};

pub const PENDING_VERSION_EMPTY: u8 = 0;
pub const PENDING_VERSION_COMMITTED: u8 = 1;
pub const PENDING_HEADER_LEN: usize = 1 + 32;
pub const PENDING_DATA_LEN: usize = PENDING_HEADER_LEN + PUBLIC_WIDTH * 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingInputsAccount {
    pub data: [u8; PENDING_DATA_LEN],
}

impl Default for PendingInputsAccount {
    fn default() -> Self {
        Self {
            data: [0u8; PENDING_DATA_LEN],
        }
    }
}

impl PendingInputsAccount {
    pub fn version(&self) -> u8 {
        self.data[0]
    }

    pub fn binder(&self) -> &[u8; 32] {
        self.data[1..33].try_into().expect("32 bytes")
    }

    pub fn is_committed(&self) -> bool {
        self.version() == PENDING_VERSION_COMMITTED
    }

    /// Tx1: write publics. Fails if already committed (must consume first).
    pub fn commit(&mut self, binder: &[u8; 32], publics: &PublicInputs) -> Result<(), KernelError> {
        if self.is_committed() {
            return Err(KernelError::PendingInputsBusy);
        }
        self.data[0] = PENDING_VERSION_COMMITTED;
        self.data[1..33].copy_from_slice(binder);
        self.data[PENDING_HEADER_LEN..].copy_from_slice(&publics.to_bytes());
        Ok(())
    }

    /// Read committed publics without consuming.
    pub fn read(&self) -> Result<PublicInputs, KernelError> {
        if !self.is_committed() {
            return Err(KernelError::PendingInputsMissing);
        }
        PublicInputs::from_bytes(&self.data[PENDING_HEADER_LEN..])
    }

    /// Spend path: require the transaction/account binder, then mark consumed (one-shot).
    pub fn consume(&mut self, expected_binder: &[u8; 32]) -> Result<PublicInputs, KernelError> {
        if !self.is_committed() {
            return Err(KernelError::PendingInputsMissing);
        }
        if self.binder() != expected_binder {
            return Err(KernelError::PendingInputsBinderMismatch);
        }
        let pi = self.read()?;
        self.data = [0u8; PENDING_DATA_LEN];
        self.data[0] = PENDING_VERSION_EMPTY;
        Ok(pi)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use siphon_kernel_types::SpendAction;

    fn sample_publics() -> PublicInputs {
        let mut pi = PublicInputs::zeroed();
        pi.limbs[0][0] = SpendAction::Swap.as_u8();
        pi.limbs[1][0] = 1;
        pi.limbs[16][0] = 4; // program version toy
        pi
    }

    #[test]
    fn commit_read_consume() {
        let mut acct = PendingInputsAccount::default();
        let binder = [7u8; 32];
        let pi = sample_publics();
        acct.commit(&binder, &pi).unwrap();
        assert!(acct.is_committed());
        assert_eq!(acct.read().unwrap().action().unwrap(), SpendAction::Swap);
        let got = acct.consume(&binder).unwrap();
        assert_eq!(got.input_count().unwrap(), 1);
        assert!(!acct.is_committed());
        assert!(acct.read().is_err());
    }

    #[test]
    fn double_commit_rejected_until_consume() {
        let mut acct = PendingInputsAccount::default();
        let pi = sample_publics();
        acct.commit(&[1u8; 32], &pi).unwrap();
        assert_eq!(
            acct.commit(&[2u8; 32], &pi).unwrap_err(),
            KernelError::PendingInputsBusy
        );
        assert_eq!(
            acct.consume(&[9u8; 32]).unwrap_err(),
            KernelError::PendingInputsBinderMismatch
        );
        let _ = acct.consume(&[1u8; 32]).unwrap();
        acct.commit(&[2u8; 32], &pi).unwrap();
    }
}
