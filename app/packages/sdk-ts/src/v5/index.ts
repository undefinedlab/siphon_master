// Siphon v5 (VaultKernel + ComplianceHub) — non-custodial client core. Secrets and proofs stay here.
export { CHAINS, chainConfig, NATIVE_TOKEN, PROGRAM_VERSION_V3 as PROGRAM_VERSION, DEFAULT_ZK_BASE_URL, type ChainConfig } from "./constants";
export { prepareDeposit, depositTransactions, finalizeDeposit, VAULT_KERNEL_ABI, type PendingDeposit, type UnsignedTx } from "./deposit";
export { prepareWithdrawal, type PreparedWithdrawal, type SpendBundle } from "./withdraw";
export { SiphonApi, SiphonApiError, intentMessage, canonicalJson, DEFAULT_API_URL, type WalletSigner, type DepositResponse, type PayoutResponse, type Operation } from "./api";
export { Prover, flattenProof, type ProverOptions, type FlatProof } from "./prover";
export { hashCommitment, hashPrecommitment, hashNullifier, deriveDepositLabel, noteAssetIdFor, assetIdFromToken } from "./noteCrypto";
export type { Note, V5DataSource, ComplianceWitness, InputCompliance, ComplianceRoots } from "./types";
