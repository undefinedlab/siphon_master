//! `solana-v1` profile bindings (payee compression, scope docs).

mod payee;

pub use payee::{PayeeCodec, SolanaPayeeCodec};

pub const PROFILE_ID: &str = siphon_kernel_types::profile_id::SOLANA_V1;
