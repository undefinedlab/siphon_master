use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum KernelError {
    #[error("proof verification failed")]
    VerifyFailed,
    #[error("programVersion limb does not match vault pin")]
    ProgramVersionMismatch,
    #[error("state root not in known historical set")]
    UnknownStateRoot,
    #[error("compliance root mismatch")]
    ComplianceRootMismatch,
    #[error("nullifier already spent")]
    NullifierSpent,
    #[error("action is paused or unknown")]
    ActionRejected,
    #[error("MERGE must zero public amount / outLabel limbs")]
    MergePrivacyViolation,
    #[error("public outLabel limb must be zero on private spend")]
    OutLabelPublicViolation,
    #[error("payeeId does not match raw payee encoding")]
    PayeeMismatch,
    #[error("action limb is not a small integer")]
    InvalidActionLimb,
    #[error("inputCount limb is invalid")]
    InvalidInputCount,
    #[error("unknown spend circuit for action/inputCount")]
    UnknownSpendCircuit,
    #[error("verify adapter not configured")]
    VerifyNotConfigured,
    #[error("adapter measured delta mismatch")]
    AdapterDeltaMismatch,
    #[error("pending public inputs already committed (consume first)")]
    PendingInputsBusy,
    #[error("pending public inputs not committed")]
    PendingInputsMissing,
    #[error("pending public inputs already consumed")]
    PendingInputsConsumed,
    #[error("pending public inputs bad length or layout")]
    PendingInputsBadLayout,
    #[error("proof byte length invalid (expected 256 uncompressed A||B||C)")]
    InvalidProofLength,
    #[error("deposits are paused")]
    DepositsPaused,
    #[error("Poseidon hashing failed")]
    PoseidonHashFailed,
    #[error("pending public inputs binder mismatch")]
    PendingInputsBinderMismatch,
}
