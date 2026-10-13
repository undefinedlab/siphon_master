use spend_core::{field_to_str, PublicOutputs, PUBLIC_WIDTH, ValidateError};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum GuestError {
    #[error(transparent)]
    Validate(#[from] ValidateError),
    #[error("guest public encoding width mismatch")]
    PublicWidth,
}

/// Committed public limbs — exactly the 25 BN254 limbs the chain verifies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedPublics {
    pub limbs: [String; PUBLIC_WIDTH],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestOutput {
    pub public: PublicOutputs,
    pub committed: CommittedPublics,
}

impl GuestOutput {
    pub fn from_public(public: PublicOutputs) -> Result<Self, GuestError> {
        let field_limbs = public.to_bn254_limbs();
        let mut limbs = Vec::with_capacity(PUBLIC_WIDTH);
        for f in field_limbs {
            limbs.push(field_to_str(&f));
        }
        let limbs: [String; PUBLIC_WIDTH] = limbs
            .try_into()
            .map_err(|_| GuestError::PublicWidth)?;
        Ok(Self {
            public,
            committed: CommittedPublics { limbs },
        })
    }
}
