//! ASP association Merkle tree — PROTOCOL.md §2.6 (insert matches on-chain `MerkleTree.sol`).

use thiserror::Error;

use crate::constants::TREE_DEPTH;
use crate::merkle::{verify_inclusion, MerklePath, MerkleError};
use crate::poseidon::{hash2, Field, PoseidonError};

#[derive(Debug, Error)]
pub enum AspError {
    #[error("asp path length mismatch")]
    PathLength,
    #[error("duplicate or zero label")]
    DuplicateLabel,
    #[error("path index bind mismatch at level {0}")]
    PathIndexBind(usize),
    #[error(transparent)]
    Poseidon(#[from] PoseidonError),
    #[error(transparent)]
    Merkle(#[from] MerkleError),
}

/// Path bit at level `i` (0 = leaf-adjacent) — LSB-first, same as `MerkleTree.sol`.
pub fn path_indices_from_leaf_index(index: u64) -> Vec<u8> {
    (0..TREE_DEPTH)
        .map(|i| ((index >> i) & 1) as u8)
        .collect()
}

/// §2.6.1 path index bind: `pathIndices[i]` equals bit `i` of leaf index (LSB at level 0).
pub fn path_index_bind_ok(index: u64, path_indices: &[u8]) -> Result<(), AspError> {
    if path_indices.len() != TREE_DEPTH {
        return Err(AspError::PathLength);
    }
    let expected = path_indices_from_leaf_index(index);
    for (i, (&got, &exp)) in path_indices.iter().zip(expected.iter()).enumerate() {
        if got != exp {
            return Err(AspError::PathIndexBind(i));
        }
    }
    Ok(())
}

pub fn empty_root() -> Field {
    AspTree::new().empty_root()
}

/// Verify label inclusion against ASP root; also checks path index bind when `leaf_index` is given.
pub fn verify_asp_inclusion(
    label: Field,
    root: Field,
    path: &MerklePath,
    leaf_index: Option<u64>,
) -> Result<bool, AspError> {
    if let Some(idx) = leaf_index {
        path_index_bind_ok(idx, &path.path_indices)?;
    }
    Ok(verify_inclusion(label, root, path)?)
}

/// Incremental ASP tree — identical insert to `siphon-contracts-v2/evm/src/NoteTree.sol`.
#[derive(Debug, Clone)]
pub struct AspTree {
    filled_subtrees: Vec<Field>,
    zeros: Vec<Field>,
    empty_root: Field,
    current_root: Field,
    pub leaf_count: u64,
    labels: Vec<Field>,
}

impl Default for AspTree {
    fn default() -> Self {
        Self::new()
    }
}

impl AspTree {
    pub fn new() -> Self {
        let mut zeros = vec![Field::from(0u64); TREE_DEPTH];
        let mut z = Field::from(0u64);
        for i in 0..TREE_DEPTH {
            zeros[i] = z;
            z = hash2(z, z).expect("zero subtree");
        }
        let empty = z;
        Self {
            filled_subtrees: zeros.clone(),
            zeros,
            empty_root: empty,
            current_root: empty,
            leaf_count: 0,
            labels: Vec::new(),
        }
    }

    pub fn empty_root(&self) -> Field {
        self.empty_root
    }

    pub fn root(&self) -> Field {
        self.current_root
    }

    /// Sibling path for the next insert slot (`leaf_count`) before mutating.
    pub fn path_for_next_insert(&self) -> MerklePath {
        self.path_at_index(self.leaf_count)
    }

    /// Leaf index of an already-inserted label, if present.
    pub fn index_of(&self, label: Field) -> Option<u64> {
        self.labels
            .iter()
            .position(|&l| l == label)
            .map(|i| i as u64)
    }

    /// Inclusion path for an already-inserted leaf index.
    pub fn path_for_index(&self, index: u64) -> Result<MerklePath, AspError> {
        if index >= self.leaf_count {
            return Err(AspError::PathLength);
        }
        Ok(self.path_at_index(index))
    }

    fn path_at_index(&self, index: u64) -> MerklePath {
        let mut path_elements = Vec::with_capacity(TREE_DEPTH);
        let mut current_index = index;
        for i in 0..TREE_DEPTH {
            let sibling = if current_index % 2 == 0 {
                self.zeros[i]
            } else {
                self.filled_subtrees[i]
            };
            path_elements.push(sibling);
            current_index >>= 1;
        }
        MerklePath {
            path_elements,
            path_indices: path_indices_from_leaf_index(index),
        }
    }

    /// Insert label at `leaf_count`; returns new root and inclusion path for this leaf.
    pub fn insert(&mut self, label: Field) -> Result<(Field, MerklePath), AspError> {
        if label == Field::from(0u64) {
            return Err(AspError::DuplicateLabel);
        }
        if self.labels.iter().any(|&l| l == label) {
            return Err(AspError::DuplicateLabel);
        }

        let index = self.leaf_count;
        let path = self.path_for_next_insert();

        let mut current_index = index;
        let mut current_level_hash = label;

        for i in 0..TREE_DEPTH {
            if current_index % 2 == 0 {
                self.filled_subtrees[i] = current_level_hash;
                current_level_hash = hash2(current_level_hash, self.zeros[i])?;
            } else {
                current_level_hash = hash2(self.filled_subtrees[i], current_level_hash)?;
            }
            current_index >>= 1;
        }

        self.current_root = current_level_hash;
        self.leaf_count += 1;
        self.labels.push(label);
        Ok((self.current_root, path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poseidon::field_from_str;

    #[test]
    fn empty_root_matches_zero_subtree() {
        let tree = AspTree::new();
        assert_eq!(tree.root(), tree.empty_root());
        assert_eq!(empty_root(), tree.empty_root());
    }

    #[test]
    fn insert_and_verify() {
        let mut tree = AspTree::new();
        let label = field_from_str("424242");
        let (root, path) = tree.insert(label).unwrap();
        assert!(verify_asp_inclusion(label, root, &path, Some(0)).unwrap());
    }

    /// DELTA F-7: OMEGA MSB-first ASP path encoding must not bind.
    #[test]
    fn f7_lsb_first_rejects_msb_path_encoding() {
        let idx = 1u64;
        let lsb = path_indices_from_leaf_index(idx);
        assert_eq!(lsb[0], 1, "LSB-first: bit0 at level 0");
        assert_eq!(lsb[TREE_DEPTH - 1], 0);
        path_index_bind_ok(idx, &lsb).unwrap();

        let mut msb = vec![0u8; TREE_DEPTH];
        msb[TREE_DEPTH - 1] = 1; // OMEGA PoC: treat level 0 as MSB
        assert!(matches!(
            path_index_bind_ok(idx, &msb),
            Err(AspError::PathIndexBind(0))
        ));
    }

    #[test]
    fn f7_leaf_index_five_bits_are_lsb_ordered() {
        // 5 = 0b101 → levels [1, 0, 1, 0, ...]
        let bits = path_indices_from_leaf_index(5);
        assert_eq!(&bits[..3], &[1, 0, 1]);
        path_index_bind_ok(5, &bits).unwrap();
    }
}
