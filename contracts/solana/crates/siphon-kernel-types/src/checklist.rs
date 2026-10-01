//! Ordered spend phases every runtime must implement (see `spec/runtime-modules.md`).

use crate::action::SpendAction;
use crate::error::KernelError;

/// Logical phases of `spend`. Adapters plug in at verify / asset / settlement ports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpendPhase {
    VerifyArtifact,
    CheckProgramVersion,
    CheckStateRoot,
    CheckComplianceRoots,
    BurnNullifiers,
    DispatchAction,
}

/// Documentation + test helper: expected phase order for a private (non-ragequit) spend.
pub struct KernelChecklist;

impl KernelChecklist {
    pub const PRIVATE_SPEND_ORDER: &'static [SpendPhase] = &[
        SpendPhase::VerifyArtifact,
        SpendPhase::CheckProgramVersion,
        SpendPhase::CheckStateRoot,
        SpendPhase::CheckComplianceRoots,
        SpendPhase::BurnNullifiers,
        SpendPhase::DispatchAction,
    ];

    /// MERGE privacy: public amount / out-label style limbs must stay zero at guest level.
    /// Concrete limb indices are enforced by circuits; runtimes re-check mux/policy hooks.
    pub fn assert_merge_policy(
        action: SpendAction,
        public_out_label_is_zero: bool,
    ) -> Result<(), KernelError> {
        if action == SpendAction::Merge && !public_out_label_is_zero {
            return Err(KernelError::MergePrivacyViolation);
        }
        Ok(())
    }

    pub fn assert_private_out_label_zero(is_zero: bool) -> Result<(), KernelError> {
        if !is_zero {
            return Err(KernelError::OutLabelPublicViolation);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_spend_order_starts_with_verify() {
        assert_eq!(
            KernelChecklist::PRIVATE_SPEND_ORDER[0],
            SpendPhase::VerifyArtifact
        );
    }
}
