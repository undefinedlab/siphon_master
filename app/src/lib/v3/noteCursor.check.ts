/**
 * Note cursor — one active note per run; bridge corridors are mainnet-only.
 *
 * Run: bunx tsx src/lib/v3/noteCursor.check.ts
 */
import assert from "node:assert/strict";
import {
  advanceCursorOnBridge,
  advanceCursorOnDeposit,
  advanceCursorOnSwap,
  advanceCursorOnWithdraw,
  assertMainnetBridgeCorridor,
  createNoteCursor,
  cursorNoteKey,
  isMainnetBridgeCorridor,
  lineageSummary,
  noteCursorRef,
} from "./noteCursor";
import { SOLANA_DEVNET_CHAIN_ID, SOLANA_MAINNET_CHAIN_ID } from "@/lib/chains/registry";

const BASE = 8453;
const ARB = 42161;

const depositArb = noteCursorRef({
  chainId: ARB,
  symbol: "USDC",
  commitment: "0xabc",
  value: 1_000_000n,
});

let cur = createNoteCursor("run-1");
cur = advanceCursorOnDeposit(cur, depositArb, { txHash: "0xdep", at: 1 });
assert.equal(cur.active?.noteKey, cursorNoteKey(ARB, "USDC", "0xabc"));
assert.equal(cur.lineage.length, 1);
assert.equal(cur.lineage[0].kind, "deposit");

const afterSwap = noteCursorRef({
  chainId: ARB,
  symbol: "ETH",
  commitment: "0xdef",
  value: 500_000_000_000_000_000n,
});
cur = advanceCursorOnSwap(cur, afterSwap, { txHash: "0xswap", at: 2 });
assert.equal(cur.active?.symbol, "ETH");
assert.equal(cur.lineage.length, 2);
assert.equal(cur.lineage[1].from?.commitment, "0xabc");

const onBase = noteCursorRef({
  chainId: BASE,
  symbol: "ETH",
  commitment: "0xbase1",
  value: 500_000_000_000_000_000n,
});
cur = advanceCursorOnBridge(cur, onBase, { txHash: "0xbr", at: 3 });
assert.equal(cur.active?.chainId, BASE);
assert.equal(cur.lineage[2].kind, "bridge");
assert.equal(cur.lineage[2].bridgeToChainId, BASE);

cur = advanceCursorOnWithdraw(cur, { txHash: "0xw", at: 4 });
assert.equal(cur.active, null);
assert.equal(cur.lineage[cur.lineage.length - 1].kind, "withdraw");
assert.match(lineageSummary(cur), /deposit@42161/);
assert.match(lineageSummary(cur), /bridge 42161→8453/);
assert.match(lineageSummary(cur), /active none/);

// --- corridor gates ---------------------------------------------------------------------------
assert.equal(isMainnetBridgeCorridor(ARB, BASE), true);
assert.equal(isMainnetBridgeCorridor(ARB, SOLANA_MAINNET_CHAIN_ID), false);
assert.equal(isMainnetBridgeCorridor(ARB, ARB), false);
assert.equal(isMainnetBridgeCorridor(ARB, SOLANA_DEVNET_CHAIN_ID), false);
assert.equal(isMainnetBridgeCorridor(SOLANA_DEVNET_CHAIN_ID, BASE), false);

assert.throws(
  () => assertMainnetBridgeCorridor(SOLANA_DEVNET_CHAIN_ID, ARB),
  /mainnet-only/,
);
assert.throws(() => assertMainnetBridgeCorridor(ARB, 11155111), /not allowed/);

// --- fail closed: swap cannot change chain; bridge cannot stay put; deposit once --------------
let bad = createNoteCursor("run-bad");
bad = advanceCursorOnDeposit(
  bad,
  noteCursorRef({ chainId: ARB, symbol: "USDC", commitment: "c1", value: "1" }),
);
assert.throws(
  () =>
    advanceCursorOnSwap(
      bad,
      noteCursorRef({ chainId: BASE, symbol: "USDC", commitment: "c2", value: "1" }),
    ),
  /same-chain only/,
);
assert.throws(
  () =>
    advanceCursorOnBridge(
      bad,
      noteCursorRef({ chainId: ARB, symbol: "USDC", commitment: "c3", value: "1" }),
    ),
  /must differ/,
);
assert.throws(
  () =>
    advanceCursorOnDeposit(
      bad,
      noteCursorRef({ chainId: ARB, symbol: "USDC", commitment: "c4", value: "1" }),
    ),
  /already has an active note/,
);
assert.throws(
  () =>
    advanceCursorOnBridge(
      bad,
      noteCursorRef({
        chainId: SOLANA_DEVNET_CHAIN_ID,
        symbol: "USDC",
        commitment: "c5",
        value: "1",
      }),
    ),
  /mainnet-only/,
);

console.log("noteCursor.check: OK — deposit→swap→bridge→withdraw cursor + mainnet corridor gates");
