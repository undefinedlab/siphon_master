use std::path::PathBuf;

pub const TREE_DEPTH: usize = 32;
pub const ADMIT_TREE_DEPTH: usize = 32;
pub const SMT_DEPTH: usize = 32;
pub const PUBLIC_WIDTH: usize = 25;
/// Limb index of `labelCommit` in the 25-limb spend public vector (COMPLIANCE_CIRCUIT_SPLIT §3.2).
pub const LABEL_COMMIT_INDEX: usize = 24;
pub const PROGRAM_VERSION: u32 = 4;
pub const MAX_INPUTS: usize = 6;
pub const MAX_SPLIT_OUTPUTS: usize = 8;

pub fn test_vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-vectors")
}
