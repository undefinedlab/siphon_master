/**
 * Siphon v5 chain registry — the published, immutable deployments.
 *
 * Mirrors siphon-app src/lib/networks.ts + src/lib/v3/configV3.ts (the dapp reads the same values
 * from NEXT_PUBLIC_V3_* at build time). `chainsParity.check.ts` in the app pins the two together.
 */
export const PROGRAM_VERSION_V3 = 5;
export const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
// The S3 bucket this used to name went dark with the AWS account it lived in (AllAccessDisabled).
// Every artifact is hash-pinned (zkPins.ts), so the host is a transport, not a trust anchor.
export const DEFAULT_ZK_BASE_URL = "https://api.siphon.money/zk";

export interface ChainConfig {
  chainId: number;
  name: string;
  vaultKernel: string;
  complianceHub: string;
  settlementAdapter: string;
  /** ERC-20 deposit approval spender (`VaultKernel.assets()`), pinned so a hostile API cannot swap it. */
  assetAdapter: string;
  noteTree: string;
  nullifierSet: string;
  deployBlock: number;
  weth: string;
  usdc: string;
  /**
   * Proving-key set the chain's verifiers were built with. Base and Arbitrum share the ceremony
   * delta; Sepolia runs dev-beacon keys. The wrong set passes a LOCAL verify and only reverts
   * ProofFailed() on-chain.
   */
  zkKeys: "ceremony" | "dev";
  mainnet: boolean;
  /** Testnet stack for Siphon operators only; the API refuses it for ordinary keys. */
  adminOnly: boolean;
}

export const CHAINS: Record<number, ChainConfig> = {
  8453: {
    chainId: 8453,
    name: "Base",
    vaultKernel: "0x240c7066a5ac7628bfC18446115B7673CEe9A35f",
    complianceHub: "0x611503a87f70bF8fc9e0CCED3227682F6119A753",
    settlementAdapter: "0x88e9CD5D0F6e6A5dF58c130de9b09069df59676D",
    assetAdapter: "0xc76FAdB7De5b5a0238a020e137A61B8d17328b43",
    noteTree: "0x94dd1A6D2Dce713A42EC784880506E77AC37c174",
    nullifierSet: "0x000725A49607450E3Ca94629Cf9df2e77CCE6d0E",
    deployBlock: 50912919,
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    zkKeys: "ceremony",
    mainnet: true,
    adminOnly: false,
  },
  42161: {
    chainId: 42161,
    name: "Arbitrum One",
    vaultKernel: "0x9Bd05D63F48F2d486D45cD549BDb4F635F90348e",
    complianceHub: "0xb4dA47B1d5239F81d95D67b1015601201b99727a",
    settlementAdapter: "0x5566a029A2FAdBFf1034804890233F41f62AA630",
    assetAdapter: "0xc59bfB9914140B7dCEaFc0cddA44e9038068310F",
    noteTree: "0xe0E802A98c1b8f1b40796d192a5b950f61E64E42",
    nullifierSet: "0xd1d5467d1aE4A52D22F2436Ca344930206b861A8",
    deployBlock: 509682895,
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    zkKeys: "ceremony",
    mainnet: true,
    adminOnly: false,
  },
  // v5 stack of 2026-09-05 (SEPOLIA_V5_ADDRESSES.md), NOT the retired 0x50Db1b65 v4 kernel. Its
  // allowed ERC-20 is the stack's test AssetToken, so that is what `usdc` points at here.
  11155111: {
    chainId: 11155111,
    name: "Ethereum Sepolia",
    vaultKernel: "0x586dFaa329D71de7368617C9f00395C040bCf84a",
    complianceHub: "0x8Dc981a93B0cfffFC4a368F4010f7581E7806D62",
    settlementAdapter: "0x0E67470B1d7AB983aEd9ECD7C113554155360e8B",
    assetAdapter: "0x9A6BFA43930a22c6c8a3965A113C6CAd484C9e1b",
    noteTree: "0x8Ba92c75F49C5B35996dDbdAc399BD4ae30CD394",
    nullifierSet: "0x0E0c55eB838E079E88F73a50950FE94319E9bF92",
    deployBlock: 11635625,
    weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    usdc: "0xf08770c1C2970243768c6c082C91F69D8C3bd775",
    zkKeys: "dev",
    mainnet: false,
    adminOnly: true,
  },
};

export function chainConfig(chainId: number): ChainConfig {
  const c = CHAINS[chainId];
  if (!c) throw new Error(`Siphon v5 is not deployed on chain ${chainId}`);
  return c;
}

/** Stand-in for the dapp's getNetwork() — only `.weth` is read by noteCrypto. */
export function getNetwork(chainId: number): { weth: string } {
  return chainConfig(chainId);
}
