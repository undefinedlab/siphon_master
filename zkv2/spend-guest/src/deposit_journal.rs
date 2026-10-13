//! Deposit guest journal — PROTOCOL.md §2.7 (5 public limbs).

use spend_core::deposit_public::{DepositOutputs, DEPOSIT_PUBLIC_WIDTH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepositCommittedPublics {
    pub limbs: Vec<String>,
}

impl DepositCommittedPublics {
    pub fn from_outputs(out: &DepositOutputs) -> Self {
        Self {
            limbs: out.limb_strings(),
        }
    }

    pub fn as_array(&self) -> Result<[String; DEPOSIT_PUBLIC_WIDTH], String> {
        if self.limbs.len() != DEPOSIT_PUBLIC_WIDTH {
            return Err(format!(
                "expected {DEPOSIT_PUBLIC_WIDTH} limbs, got {}",
                self.limbs.len()
            ));
        }
        let mut arr: [String; DEPOSIT_PUBLIC_WIDTH] =
            std::array::from_fn(|_| String::new());
        for (i, limb) in self.limbs.iter().enumerate() {
            arr[i] = limb.clone();
        }
        Ok(arr)
    }
}

#[derive(Debug, Clone)]
pub struct DepositGuestOutput {
    pub public: DepositOutputs,
    pub committed: DepositCommittedPublics,
}

impl DepositGuestOutput {
    pub fn from_public(public: DepositOutputs) -> Self {
        let committed = DepositCommittedPublics::from_outputs(&public);
        Self { public, committed }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DepositGuestError {
    #[error(transparent)]
    Validate(#[from] spend_core::validate::ValidateError),
}
