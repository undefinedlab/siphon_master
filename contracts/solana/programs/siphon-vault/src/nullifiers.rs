//! Nullifier persistence boundary (on-chain = one PDA per nullifier).

use siphon_kernel_types::KernelError;
use std::collections::HashSet;

#[derive(Default, Debug)]
pub struct NullifierSet {
    spent: HashSet<[u8; 32]>,
}

/// PDA address material is represented as two legal Solana seeds and is logically
/// `b"nf" || nullifier`. A created account means the nullifier has been spent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NullifierPdaKey {
    pub nullifier: [u8; 32],
}

impl NullifierPdaKey {
    pub const PREFIX: &'static [u8] = b"nf";

    pub fn new(nullifier: [u8; 32]) -> Self {
        Self { nullifier }
    }

    pub fn seeds(&self) -> [&[u8]; 2] {
        [Self::PREFIX, &self.nullifier]
    }
}

pub trait PersistentNullifierStore {
    fn is_spent(&self, nullifier: &[u8; 32]) -> Result<bool, KernelError>;
    fn burn(&mut self, nullifier: &[u8; 32]) -> Result<(), KernelError>;
}

impl NullifierSet {
    pub fn contains(&self, n: &[u8; 32]) -> bool {
        self.spent.contains(n)
    }

    pub fn burn(&mut self, n: &[u8; 32]) -> Result<(), KernelError> {
        if n == &[0u8; 32] {
            return Ok(()); // inactive slot padding
        }
        if !self.spent.insert(*n) {
            return Err(KernelError::NullifierSpent);
        }
        Ok(())
    }
}

impl PersistentNullifierStore for NullifierSet {
    fn is_spent(&self, nullifier: &[u8; 32]) -> Result<bool, KernelError> {
        Ok(self.contains(nullifier))
    }

    fn burn(&mut self, nullifier: &[u8; 32]) -> Result<(), KernelError> {
        NullifierSet::burn(self, nullifier)
    }
}
