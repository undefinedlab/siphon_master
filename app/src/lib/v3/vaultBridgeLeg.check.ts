/**
 * Vault bridge leg — Base↔Arb ETH/USDC corridor + prompt detection.
 *
 * Run: bunx tsx src/lib/v3/vaultBridgeLeg.check.ts
 */
import assert from "node:assert/strict";
import {
  detectBridgeChainsFromPrompt,
  prepareVaultBridgeLeg,
  resolveBridgeVaultChainId,
  validateVaultBridgeBlock,
} from "./vaultBridgeLeg";
import { clearNoteCursor, recordDepositOnCursor } from "./noteCursorSession";

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

assert.equal(resolveBridgeVaultChainId("Arbitrum"), 42161);
assert.equal(resolveBridgeVaultChainId("base"), 8453);
assert.equal(resolveBridgeVaultChainId("Solana"), null, "Solana not in v1 channel");

const ok = validateVaultBridgeBlock({ fromChain: "Arbitrum", toChain: "Base", symbol: "USDC" });
assert.equal(ok.ok, true);
if (ok.ok) {
  assert.equal(ok.fromChainId, 42161);
  assert.equal(ok.toChainId, 8453);
  assert.equal(ok.symbol, "USDC");
}

assert.equal(validateVaultBridgeBlock({ fromChain: "Arbitrum", toChain: "Arbitrum" }).ok, false);
assert.equal(validateVaultBridgeBlock({ fromChain: "Arbitrum", toChain: "Base", symbol: "WBTC" }).ok, false);
assert.equal(validateVaultBridgeBlock({ fromChain: "Arbitrum", toChain: "Solana" }).ok, false);

const detected = detectBridgeChainsFromPrompt(
  "Deposit USDC on Arbitrum, bridge to Base, then limit buy ETH",
);
assert.equal(detected.from, "Arbitrum");
assert.equal(detected.to, "Base");

clearNoteCursor();
assert.equal(prepareVaultBridgeLeg({ fromChain: "Arbitrum", toChain: "Base" }).ok, false);

recordDepositOnCursor({
  chainId: 42161,
  symbol: "USDC",
  commitment: "0xbridge",
  value: "1000000",
});
const ready = prepareVaultBridgeLeg({ fromChain: "Arbitrum", toChain: "Base", symbol: "USDC" });
assert.equal(ready.ok, true);
if (ready.ok) {
  assert.match(ready.message, /Arbitrum → Base/);
}

const ethOk = validateVaultBridgeBlock({ fromChain: "Base", toChain: "Arbitrum", symbol: "ETH" });
assert.equal(ethOk.ok, true);

console.log("vaultBridgeLeg.check: OK — Base↔Arb USDC/ETH corridors + prompt detect");
