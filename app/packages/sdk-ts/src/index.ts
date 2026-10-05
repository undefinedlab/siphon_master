export { SiphonClient, type SiphonClientConfig, type RequestOptions } from "./client";
export {
  type NoteSecrets,
  type FheKeyPair,
  generateNote,
  generateFheKeyPair,
  encryptValueFhe,
  poseidonHash,
  FIELD_SIZE
} from "./crypto";
export * from "./errors";
export {
  assessStrategyArming,
  armFailClosedEnabled,
  armForceAllowed,
  getAnonymitySet,
  getRecentVaultSwaps,
  getUniswapPoolDepth,
  MAX_SWAP_QUERY_LIMIT,
  BASE_WETH,
  BASE_USDC,
  type AnonymitySetResult,
  type ArmAssessment,
  type PoolDepthResult,
  type VaultSwapRow,
  type GraphSource,
} from "./graph";

// v5 protocol (live on Base + Arbitrum). The top-level exports above target the retired v1 API.
export * as v5 from "./v5";

// Solana Devnet (chain 900002): the ZK vault program through the same API.
export * as solana from "./solana";
