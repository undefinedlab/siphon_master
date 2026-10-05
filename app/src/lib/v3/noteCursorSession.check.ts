/**
 * Note cursor session — deposit opens a run; swap advances; withdraw clears.
 *
 * Run: bunx tsx src/lib/v3/noteCursorSession.check.ts
 */
import assert from "node:assert/strict";
import {
  clearNoteCursor,
  loadNoteCursor,
  peekActiveNoteCursor,
  recordBridgeOnCursor,
  recordDepositOnCursor,
  recordSwapOnCursor,
  recordWithdrawOnCursor,
  saveNoteCursor,
} from "./noteCursorSession";
import { createNoteCursor } from "./noteCursor";

// jsdom-free localStorage shim for Node.
const mem = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => {
    mem.set(k, String(v));
  },
  removeItem: (k) => {
    mem.delete(k);
  },
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage;

clearNoteCursor();
assert.equal(loadNoteCursor(), null);

const afterDep = recordDepositOnCursor({
  chainId: 42161,
  symbol: "USDC",
  commitment: "0xdep1",
  value: 1_000_000n,
  txHash: "0xd",
});
assert.ok(afterDep?.active);
assert.equal(peekActiveNoteCursor()?.commitment, "0xdep1");
assert.equal(loadNoteCursor()?.lineage[0]?.kind, "deposit");

const afterSwap = recordSwapOnCursor({
  chainId: 42161,
  symbol: "ETH",
  commitment: "0xsw1",
  value: "100",
});
assert.equal(afterSwap?.active?.symbol, "ETH");
assert.equal(loadNoteCursor()?.lineage.length, 2);

const afterBridge = recordBridgeOnCursor({
  chainId: 8453,
  symbol: "ETH",
  commitment: "0xb1",
  value: "100",
});
assert.equal(afterBridge?.active?.chainId, 8453);

assert.equal(
  recordSwapOnCursor({
    chainId: 42161,
    symbol: "USDC",
    commitment: "0xwrongchain",
    value: "1",
  }),
  null,
  "swap on a different chain must not move the cursor",
);

const afterWd = recordWithdrawOnCursor({ txHash: "0xw" });
assert.equal(afterWd?.active, null);
assert.equal(peekActiveNoteCursor(), null);

// Devnet bridge must fail closed (helper returns null, does not corrupt storage).
recordDepositOnCursor({
  chainId: 42161,
  symbol: "USDC",
  commitment: "0xagain",
  value: "5",
});
assert.equal(
  recordBridgeOnCursor({
    chainId: 900_002,
    symbol: "USDC",
    commitment: "0xdev",
    value: "5",
  }),
  null,
);
assert.equal(peekActiveNoteCursor()?.commitment, "0xagain");

// save/load round-trip
const manual = createNoteCursor("manual-run");
saveNoteCursor(manual);
assert.equal(loadNoteCursor()?.runId, "manual-run");
clearNoteCursor();

console.log("noteCursorSession.check: OK — deposit/swap/bridge/withdraw + fail-open gates");
