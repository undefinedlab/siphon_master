//! Depth-32 incremental Poseidon note tree matching the protocol's LSB-first append semantics.

use siphon_kernel_types::KernelError;

use crate::poseidon::{field_from_le_bytes, field_to_le_bytes, hash2, Field};

pub const NOTE_TREE_DEPTH: u8 = 32;

#[derive(Clone, Debug)]
pub struct NoteTree {
    pub depth: u8,
    pub next_index: u64,
    pub root: [u8; 32],
    /// Historical roots (including current) for spend stateRoot checks.
    pub history: Vec<[u8; 32]>,
    filled_subtrees: Vec<Field>,
    zeros: Vec<Field>,
}

impl NoteTree {
    pub fn new(depth: u8) -> Self {
        assert_eq!(
            depth, NOTE_TREE_DEPTH,
            "the protocol note tree depth is fixed"
        );
        let mut zeros = Vec::with_capacity(depth as usize);
        let mut zero = Field::from(0u64);
        for _ in 0..depth {
            zeros.push(zero);
            zero = hash2(zero, zero).expect("fixed Poseidon parameters");
        }
        let root = field_to_le_bytes(&zero);
        Self {
            depth,
            next_index: 0,
            root,
            history: vec![root],
            filled_subtrees: zeros.clone(),
            zeros,
        }
    }

    pub fn known_roots(&self) -> &[[u8; 32]] {
        &self.history
    }

    /// Insert note commitment; returns leaf index.
    pub fn insert(&mut self, commitment: [u8; 32]) -> Result<u64, KernelError> {
        let idx = self.next_index;
        if idx >= (1u64 << self.depth) {
            return Err(KernelError::AdapterDeltaMismatch);
        }

        let mut current_index = idx;
        let mut current = field_from_le_bytes(&commitment);
        for level in 0..self.depth as usize {
            if current_index & 1 == 0 {
                self.filled_subtrees[level] = current;
                current = hash2(current, self.zeros[level])?;
            } else {
                current = hash2(self.filled_subtrees[level], current)?;
            }
            current_index >>= 1;
        }

        self.next_index = idx + 1;
        self.root = field_to_le_bytes(&current);
        self.history.push(self.root);
        Ok(idx)
    }
}

impl Default for NoteTree {
    fn default() -> Self {
        Self::new(NOTE_TREE_DEPTH)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_updates_history() {
        let mut t = NoteTree::new(32);
        let i0 = t.insert([1u8; 32]).unwrap();
        assert_eq!(i0, 0);
        assert_eq!(t.known_roots().len(), 2);
        let _ = t.insert([2u8; 32]).unwrap();
        assert_eq!(t.known_roots().len(), 3);
        assert_ne!(t.known_roots()[1], t.root);
    }
}
