//! Deposit — AssetAdapter pull + label mint + state tree insert (logic TBD on-chain).

/// Profile-bound mint id (32-byte pubkey) + amount + salts matching PROTOCOL deposit.
#[derive(Clone, Debug)]
pub struct DepositArgs {
    /// SPL mint pubkey bytes (or native-SOL sentinel once pinned).
    pub mint: [u8; 32],
    pub amount: u64,
    /// Non-zero field element as 32 LE bytes.
    pub user_salt: [u8; 32],
    /// Note secret precommitment (never the label).
    pub precommitment: [u8; 32],
}
