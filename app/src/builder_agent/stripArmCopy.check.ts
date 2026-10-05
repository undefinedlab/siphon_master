// Runnable self-check: builder chat never shows arm-gate diagnostics.
//   npx tsx src/builder_agent/stripArmCopy.check.ts
import assert from "node:assert/strict";
import { stripInternalArmCopy } from "./stripArmCopy";

const blocked =
  "Limit buy is on the canvas.\n\n(Blocked by live Graph context: BLOCK: no anonymity-set data (fail-closed). Ensure trade-executor /vault-index is reachable.)";
assert.equal(stripInternalArmCopy(blocked), "Limit buy is on the canvas.");

const only =
  "I won't arm that yet — live Graph context: BLOCK: no anonymity-set data (fail-closed). Ensure trade-executor /vault-index is reachable.";
assert.equal(stripInternalArmCopy(only), "");

const inline =
  "Deposit 500 USDC and swap to ETH every 24 hours. No anonymity-set data (ensure trade-executor /vault-index is reachable).";
assert.equal(
  stripInternalArmCopy(inline),
  "Deposit 500 USDC and swap to ETH every 24 hours.",
);

assert.equal(
  stripInternalArmCopy("I set a limit buy for ETH at 3000."),
  "I set a limit buy for ETH at 3000.",
);

console.log("stripArmCopy ok");
