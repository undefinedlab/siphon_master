// Runnable self-check for v4 pair/venue resolution (no test framework in this repo).
//   npx tsx src/lib/v4/strategyLegs.check.ts
// v4PairFor decides BOTH whether a leg routes through the v4 hook and which swap DIRECTION it takes
// (zeroForOne). A wrong direction swaps the wrong way; a false-positive venue routes a pair with no
// pool. Both are silent money bugs, so guard the resolution.
import assert from "node:assert";
import { V4, v4PairFor, poolForPair, REAL_POOL } from "./config";

const CHAIN = V4.chainId;
const t0 = V4.poolKey.currency0;
const t1 = V4.poolKey.currency1;
const UNKNOWN = "0x000000000000000000000000000000000000dEaD";

// currency0 -> currency1 spends token0: zeroForOne == true.
const fwd = v4PairFor(CHAIN, t0, t1);
assert(fwd && fwd.zeroForOne === true, "token0 -> token1 must resolve zeroForOne=true");

// currency1 -> currency0 spends token1: zeroForOne == false.
const rev = v4PairFor(CHAIN, t1, t0);
assert(rev && rev.zeroForOne === false, "token1 -> token0 must resolve zeroForOne=false");

// Case-insensitive on address (checksummed vs lower).
assert(v4PairFor(CHAIN, t0.toLowerCase(), t1.toUpperCase().replace("0X", "0x")) !== null,
  "pair match must be case-insensitive on the token address");

// A pair without a registered pool → null → caller keeps the v3 path (no false-positive routing).
assert(v4PairFor(CHAIN, t0, UNKNOWN) === null, "unregistered pair must resolve null (stay on v3)");
assert(v4PairFor(CHAIN, UNKNOWN, t1) === null, "unregistered pair must resolve null (stay on v3)");

// Wrong chain → null (v4 is Sepolia-only).
assert(v4PairFor(1, t0, t1) === null, "non-Sepolia chain must resolve null");

// Real WETH/USDC pool (currency0 == USDC): USDC→WETH spends currency0 → zeroForOne=true; the
// reverse (WETH→USDC) is zeroForOne=false. Getting this backwards swaps the wrong way.
const usdc = REAL_POOL.token0.address; // currency0
const weth = REAL_POOL.token1.address; // currency1
const buy = poolForPair(CHAIN, usdc, weth);
assert(buy && buy.zeroForOne === true && buy.pool === REAL_POOL, "USDC→WETH must resolve REAL_POOL zeroForOne=true");
const sell = poolForPair(CHAIN, weth, usdc);
assert(sell && sell.zeroForOne === false && sell.pool === REAL_POOL, "WETH→USDC must resolve REAL_POOL zeroForOne=false");

console.log("OK — v4PairFor/poolForPair resolve the real pool + direction; v3 for unknown pairs");
