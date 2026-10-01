//! Account state shapes for Solana vault + compliance (borsh/Anchor encoding later).

/// Vault PDA — mirrors VaultKernel immutables / storage on EVM.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultState {
    /// Poseidon(DOMAIN_CHAIN_SOL, programIdField, vaultPdaField) — pinned at init.
    pub vault_scope_id: [u8; 32],
    /// Pinned PROGRAM_VERSION limb (must match publicInputs[16]).
    pub program_version: [u8; 32],
    pub deposit_nonce: u64,
    pub state_root: [u8; 32],
    pub deposits_paused: bool,
    /// Bitmask for actions 0–4 paused.
    pub action_paused_mask: u8,
}

/// Shared compliance roots (ComplianceHub analogue).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComplianceState {
    pub admitted_root: [u8; 32],
    pub revoked_root: [u8; 32],
}

/// Nullifier presence is runtime-specific (PDA map, sparse merkle, etc.).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NullifierRecord {
    pub nullifier: [u8; 32],
    pub spent: bool,
}
