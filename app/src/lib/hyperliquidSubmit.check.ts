/**
 * Option A private-perps vault gates (HyperEVM Testnet 998 + Base 8453).
 * Run: npx tsx src/lib/hyperliquidSubmit.check.ts
 */
import assert from "node:assert/strict";
import {
  HYPERLIQUID_CHAIN_ID,
  PERPS_VAULT_BASE,
  PERPS_VAULT_CHAIN_IDS,
  PERPS_VAULT_HYPEREVM_TESTNET,
  isHyperevmTestnetPerps,
  isPerpsVaultChain,
} from "./hyperliquidSubmit";

assert.equal(PERPS_VAULT_BASE, 8453);
assert.equal(PERPS_VAULT_HYPEREVM_TESTNET, 998);
assert.equal(HYPERLIQUID_CHAIN_ID, 1337);
assert.deepEqual([...PERPS_VAULT_CHAIN_IDS], [8453, 998]);

assert.equal(isPerpsVaultChain(8453), true);
assert.equal(isPerpsVaultChain(998), true);
assert.equal(isPerpsVaultChain(42161), false);

assert.equal(isHyperevmTestnetPerps(998), true);
assert.equal(isHyperevmTestnetPerps(8453), false);

console.log("hyperliquidSubmit.check: ok");
