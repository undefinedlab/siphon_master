/**
 * A swap's destination asset must be a real ERC-20, never the native sentinel.
 *
 * Regression this locks down: v3SwapParams returned `BigInt(outToken.address)`, so a USDC->ETH
 * order carried 0xEeee…EEeE as its destination. VaultKernel checks that against its allowlist
 * (`_requireAllowedAsset(pi[18])`), which holds WETH and never the sentinel, so the leg proved
 * correctly inside the enclave and then reverted on-chain with TokenNotAllowed() — after the
 * user had already paid the arming fee.
 *
 * The same value becomes the OUTPUT note's assetId, so it is also a fund-safety check: a note
 * denominated in the sentinel can never be spent, because withdrawal casts the assetId back to a
 * token address and that address holds no balance.
 *
 * Run: bunx tsx src/lib/v3/swapDstAsset.check.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { noteAssetAddress } from "./noteCryptoV3";
import { NATIVE_TOKEN, getNetwork } from "../networks";

const BASE = 8453;
const SENTINEL = NATIVE_TOKEN.toLowerCase();
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// --- native must resolve to real WETH, on every v3 chain -------------------------------------
for (const chainId of [BASE, 11155111]) {
  const weth = getNetwork(chainId).weth;
  for (const native of [NATIVE_TOKEN, "0x0000000000000000000000000000000000000000", ""]) {
    const got = noteAssetAddress(chainId, native);
    assert.strictEqual(got.toLowerCase(), weth.toLowerCase(),
      `chain ${chainId}: native "${native}" must map to WETH, got ${got}`);
    assert.notStrictEqual(got.toLowerCase(), SENTINEL,
      `chain ${chainId}: the sentinel must never survive as an asset id`);
  }
}

// --- a real ERC-20 must pass through untouched ------------------------------------------------
assert.strictEqual(noteAssetAddress(BASE, USDC), USDC, "an ERC-20 address must not be rewritten");

// --- the assetId a swap actually publishes -----------------------------------------------------
// uint160(assetId) is how the kernel recovers the token, so compare in that domain.
const dstAssetId = BigInt(noteAssetAddress(BASE, NATIVE_TOKEN));
assert.strictEqual(dstAssetId, BigInt(getNetwork(BASE).weth), "dst assetId must be WETH's uint160");
assert.notStrictEqual(dstAssetId, BigInt(NATIVE_TOKEN), "dst assetId must never be the sentinel");

// --- no v3 call site may rebuild the raw form --------------------------------------------------
// The bug was one un-mapped conversion sitting two lines below a mapped one, so guard the source
// as well as the behaviour: every dstToken must be routed through noteAssetAddress.
const src = readFileSync("src/lib/v3/strategyOrchestrateV3.ts", "utf8");
// Assignments only — `dstToken: bigint;` in an interface is a type, not a conversion.
const dstLines = src
  .split("\n")
  .filter((l) => /^\s*dstToken:/.test(l) && !/^\s*dstToken:\s*(bigint|string|number)\s*;/.test(l));
assert.ok(dstLines.length > 0, "expected a dstToken assignment in v3SwapParams");
for (const line of dstLines) {
  assert.ok(
    line.includes("noteAssetAddress") || line.includes("p.swap.dstToken"),
    `dstToken must go through noteAssetAddress, found: ${line.trim()}`,
  );
}

console.log(
  "swapDstAsset.check: OK — native maps to WETH on both v3 chains, ERC-20s pass through, " +
    "the published assetId is never the sentinel, and no dstToken bypasses noteAssetAddress",
);
