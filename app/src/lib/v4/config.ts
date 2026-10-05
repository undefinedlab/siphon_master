/**
 * Siphon v4 shielded-swap deployment (Ethereum Sepolia).
 * Source of truth: siphon-contracts/evm/ignition/deployments/chain-11155111/v4_deployed_addresses.json
 */
export const TREE_DEPTH = 32;
// Swap sqrt-price limits: use PLUS_1 for zeroForOne (price falls), MINUS_1 for the reverse.
export const MIN_SQRT_PRICE_PLUS_1 = 4295128740n;
export const MAX_SQRT_PRICE_MINUS_1 = 1461446703485210103287273052203988822378723970341n;

const CHAIN_ID = 11155111;
// Safely predates the v4 deployment. Log scans start here instead of genesis and are chunked, so
// wallet RPCs with a 50k-block eth_getLogs cap never receive an oversized request.
const DEPLOY_BLOCK = 11336000;
const HOOK = "0xfaBa649Ce2982f61B0488383671A19BAfe2440c0";
const VAULT = "0xed4739305818457dcAE2d68fA4042C165732DDB4";
// One-tx deposit helper: depositETH wraps native ETH → WETH + deposits atomically (no approve).
const DEPOSITOR = "0xA1c924a53d0d7f21fd6d762906Ecdc91100A94bB";
export const WETH_ADDRESS = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

export interface V4PoolToken {
  address: string;
  symbol: string;
  decimals: number;
  tree: string;
}
export interface V4Pool {
  poolKey: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
  token0: V4PoolToken; // == currency0
  token1: V4PoolToken; // == currency1
}

function mkPool(token0: V4PoolToken, token1: V4PoolToken, fee = 3000, tickSpacing = 60): V4Pool {
  return { poolKey: { currency0: token0.address, currency1: token1.address, fee, tickSpacing, hooks: HOOK }, token0, token1 };
}

// Real Sepolia WETH/USDC (production strategies). currency0 < currency1 by address → USDC is currency0.
export const REAL_POOL = mkPool(
  { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", symbol: "USDC", decimals: 6, tree: "0x22A7236Fb06e0a8Cd74BF4b5f7Eb44367013C466" },
  { address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", symbol: "WETH", decimals: 18, tree: "0x5FD7EE12BBC08138553eb3095E824b10494eF0d2" },
);

/** Previous immutable deployment. Existing browser notes without an explicit vault belong here. */
export const LEGACY_V4 = {
  deployBlock: 11278212,
  vault: "0x0FBB5E22838679A9e96F2cF400C7f41D13A9c752",
  hook: "0xF5Ec4Fa4ab1bbEa79CC16470220667E77594C0c0",
  trees: {
    ["0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238".toLowerCase()]: "0xF480b83Fb650DE4A84F656DB3a584A70b51A4c5c",
    ["0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14".toLowerCase()]: "0x3e41d2bba171bd9aF3b24798367114Ad34815cEC",
  } as Record<string, string>,
} as const;

// Only real assets are routable. The old sUSDC/sWETH deployment may still exist on-chain, but the
// production app must never select it as an implicit fallback.
export const V4_POOLS: V4Pool[] = [REAL_POOL];

/** The registered tree for a token (searches all pools). Throws if the token has no v4 tree. */
export function treeOf(token: string): string {
  const t = token.toLowerCase();
  for (const p of V4_POOLS) {
    if (p.token0.address.toLowerCase() === t) return p.token0.tree;
    if (p.token1.address.toLowerCase() === t) return p.token1.tree;
  }
  throw new Error(`no v4 tree registered for token ${token}`);
}

/**
 * Resolve the full v4 pool + swap direction for a token pair, or null if none is registered.
 * `zeroForOne` says which direction spends `tokenA` (true when tokenA == currency0).
 */
export function poolForPair(chainId: number, tokenA: string, tokenB: string): { pool: V4Pool; zeroForOne: boolean } | null {
  if (chainId !== CHAIN_ID) return null;
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  for (const pool of V4_POOLS) {
    const c0 = pool.poolKey.currency0.toLowerCase();
    const c1 = pool.poolKey.currency1.toLowerCase();
    if (a === c0 && b === c1) return { pool, zeroForOne: true };
    if (a === c1 && b === c0) return { pool, zeroForOne: false };
  }
  return null;
}

/**
 * Resolve the v4 pool for a token pair, or null (→ caller keeps the v3 path). Mirror of the
 * executor's v4_config.v4_pool_for. Only pairs with a deployed pool + registered per-token trees +
 * seeded liquidity are routable — tokens WITHOUT a v4 pool transparently stay on v3.
 */
export function v4PairFor(
  chainId: number,
  tokenA: string,
  tokenB: string,
): { poolKey: V4Pool["poolKey"]; zeroForOne: boolean } | null {
  const r = poolForPair(chainId, tokenA, tokenB);
  return r ? { poolKey: r.pool.poolKey, zeroForOne: r.zeroForOne } : null;
}

// Backward-compatible surface for callers that use the singleton v4 config. It now defaults to
// the real pool as well, so omitting an explicit pool can never route into the retired demo pair.
export const V4 = {
  chainId: CHAIN_ID,
  deployBlock: DEPLOY_BLOCK,
  vault: VAULT,
  hook: HOOK,
  depositor: DEPOSITOR,
  poolKey: REAL_POOL.poolKey,
  tokens: {
    token0: { address: REAL_POOL.token0.address, symbol: REAL_POOL.token0.symbol, decimals: REAL_POOL.token0.decimals },
    token1: { address: REAL_POOL.token1.address, symbol: REAL_POOL.token1.symbol, decimals: REAL_POOL.token1.decimals },
  },
  treeOf,
} as const;

export const VAULT_ABI = [
  "function deposit(address token, uint256 amount, uint256 precommitment) returns (uint256)",
  "function shieldedSwap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,bytes hookData) returns (int256)",
  "function withdraw(address token,address recipient,uint256 withdrawnValue,uint256 stateRoot,uint256 changeCommitment,uint256 nullifierHash,uint256[2] pA,uint256[2][2] pB,uint256[2] pC)",
  "function nullifiers(uint256) view returns (bool)",
  "function treeOf(address) view returns (address)",
  "function rootExists(address token,uint256 root) view returns (bool)",
  "function getFeeInfo(address token) view returns (bool enabled,uint16 feeBps,uint256 minWithdraw,address collector)",
  "function quoteWithdrawFee(address token,uint256 withdrawnValue) view returns (uint256 fee,uint256 margin,uint256 gasReimburse)",
  "event ShieldedSwap(bytes32 indexed poolId,uint256 nullifierHash,uint256 changeCommitment,uint256 outputCommitment,uint256 amountOut)",
];

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
  "function decimals() view returns (uint8)",
];

export const MERKLE_TREE_ABI = [
  "function getRoot() view returns (uint256)",
  "function getSize() view returns (uint256)",
  "function rootExists(uint256 root) view returns (bool)",
  "event LeafInserted(uint256 _index, uint256 _leaf, uint256 _root)",
];

export const DEPOSITOR_ABI = [
  "function depositETH(uint256 precommitment) payable returns (uint256)",
  "function depositToken(address token, uint256 amount, uint256 precommitment) returns (uint256)",
];
