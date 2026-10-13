use thiserror::Error;

use crate::constants::TREE_DEPTH;
use crate::poseidon::{hash2, Field, PoseidonError};

#[derive(Debug, Clone)]
pub struct MerklePath {
    pub path_elements: Vec<Field>,
    pub path_indices: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum MerkleError {
    #[error("merkle path length mismatch")]
    PathLength,
    #[error("invalid path index (must be 0 or 1)")]
    InvalidIndex,
    #[error(transparent)]
    Poseidon(#[from] PoseidonError),
}

pub fn verify_inclusion(
    leaf: Field,
    root: Field,
    path: &MerklePath,
) -> Result<bool, MerkleError> {
    if path.path_elements.len() != TREE_DEPTH || path.path_indices.len() != TREE_DEPTH {
        return Err(MerkleError::PathLength);
    }
    let mut current = leaf;
    for i in 0..TREE_DEPTH {
        let idx = path.path_indices[i];
        if idx > 1 {
            return Err(MerkleError::InvalidIndex);
        }
        let sibling = path.path_elements[i];
        current = if idx == 0 {
            hash2(current, sibling)?
        } else {
            hash2(sibling, current)?
        };
    }
    Ok(current == root)
}

/// Path bit at level `i` (0 = leaf-adjacent, LSB) — matches on-chain `MerkleTree.sol`.
pub fn path_indices_from_index(index: u64) -> Vec<u8> {
    (0..TREE_DEPTH)
        .map(|i| ((index >> i) & 1) as u8)
        .collect()
}

/// Incremental Merkle tree — same insert semantics as `MerkleTree.sol` / ASP (§2.4).
#[derive(Debug, Clone)]
pub struct IncrementalMerkleTree {
    filled_subtrees: Vec<Field>,
    zeros: Vec<Field>,
    empty_root: Field,
    current_root: Field,
    pub leaf_count: u64,
}

impl Default for IncrementalMerkleTree {
    fn default() -> Self {
        Self::new()
    }
}

impl IncrementalMerkleTree {
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
        }
    }

    pub fn empty_root(&self) -> Field {
        self.empty_root
    }

    pub fn root(&self) -> Field {
        self.current_root
    }

    pub fn path_at_index(&self, index: u64) -> MerklePath {
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
            path_indices: path_indices_from_index(index),
        }
    }

    pub fn insert(&mut self, leaf: Field) -> Result<(Field, MerklePath), MerkleError> {
        let index = self.leaf_count;
        let path = self.path_at_index(index);

        let mut current_index = index;
        let mut current_level_hash = leaf;

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
        Ok((self.current_root, path))
    }
}
