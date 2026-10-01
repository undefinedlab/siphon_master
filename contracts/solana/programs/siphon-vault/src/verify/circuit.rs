//! Action → circuit id routing (mirrors EVM SpendActionGroth16Router).

use siphon_kernel_types::{KernelError, PublicInputs, SpendAction};

/// One Circom Groth16 verifying key slot per circuit family.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SpendCircuitId {
    Withdraw1,
    Withdraw2,
    Withdraw3,
    Withdraw4,
    Withdraw5,
    Withdraw6,
    Merge2,
    Merge3,
    Merge4,
    Merge5,
    Merge6,
    Swap,
    Split,
    Ragequit,
}

impl SpendCircuitId {
    pub const ALL: &'static [SpendCircuitId] = &[
        Self::Withdraw1,
        Self::Withdraw2,
        Self::Withdraw3,
        Self::Withdraw4,
        Self::Withdraw5,
        Self::Withdraw6,
        Self::Merge2,
        Self::Merge3,
        Self::Merge4,
        Self::Merge5,
        Self::Merge6,
        Self::Swap,
        Self::Split,
        Self::Ragequit,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Withdraw1 => "withdraw1",
            Self::Withdraw2 => "withdraw2",
            Self::Withdraw3 => "withdraw3",
            Self::Withdraw4 => "withdraw4",
            Self::Withdraw5 => "withdraw5",
            Self::Withdraw6 => "withdraw6",
            Self::Merge2 => "merge2",
            Self::Merge3 => "merge3",
            Self::Merge4 => "merge4",
            Self::Merge5 => "merge5",
            Self::Merge6 => "merge6",
            Self::Swap => "swap",
            Self::Split => "split",
            Self::Ragequit => "ragequit",
        }
    }
}

pub fn circuit_for_publics(pi: &PublicInputs) -> Result<SpendCircuitId, KernelError> {
    let action = pi.action()?;
    let n = pi.input_count()?;
    circuit_for(action, n)
}

pub fn circuit_for(action: SpendAction, input_count: u8) -> Result<SpendCircuitId, KernelError> {
    match (action, input_count) {
        (SpendAction::Withdraw, 1) => Ok(SpendCircuitId::Withdraw1),
        (SpendAction::Withdraw, 2) => Ok(SpendCircuitId::Withdraw2),
        (SpendAction::Withdraw, 3) => Ok(SpendCircuitId::Withdraw3),
        (SpendAction::Withdraw, 4) => Ok(SpendCircuitId::Withdraw4),
        (SpendAction::Withdraw, 5) => Ok(SpendCircuitId::Withdraw5),
        (SpendAction::Withdraw, 6) => Ok(SpendCircuitId::Withdraw6),
        (SpendAction::Merge, 2) => Ok(SpendCircuitId::Merge2),
        (SpendAction::Merge, 3) => Ok(SpendCircuitId::Merge3),
        (SpendAction::Merge, 4) => Ok(SpendCircuitId::Merge4),
        (SpendAction::Merge, 5) => Ok(SpendCircuitId::Merge5),
        (SpendAction::Merge, 6) => Ok(SpendCircuitId::Merge6),
        (SpendAction::Swap, 1) => Ok(SpendCircuitId::Swap),
        (SpendAction::Split, 1) => Ok(SpendCircuitId::Split),
        (SpendAction::Ragequit, 1) => Ok(SpendCircuitId::Ragequit),
        _ => Err(KernelError::UnknownSpendCircuit),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_like_evm_router() {
        assert_eq!(
            circuit_for(SpendAction::Swap, 1).unwrap(),
            SpendCircuitId::Swap
        );
        assert_eq!(
            circuit_for(SpendAction::Merge, 6).unwrap(),
            SpendCircuitId::Merge6
        );
        assert!(circuit_for(SpendAction::Merge, 1).is_err());
        assert!(circuit_for(SpendAction::Withdraw, 7).is_err());
    }
}
