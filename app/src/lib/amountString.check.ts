// Runnable self-check for human-amount normalisation — no test framework in this repo.
//   npx tsx src/lib/amountString.check.ts
//
// The cases below are the real failures this module exists to prevent, not invented ones.
import assert from "node:assert";
import { parseUnits } from "ethers";

import { displayAmount, toAmountString } from "./amountString";

// --- the crash: String(8.1e-7) is "8.1e-7", which parseUnits rejects outright.
assert.equal(String(8.1e-7), "8.1e-7", "premise: JS goes exponential below 1e-6");
assert.equal(toAmountString(8.1e-7, 18), "0.00000081");
assert.doesNotThrow(() => parseUnits(toAmountString(8.1e-7, 18), 18));

// --- the second, hidden crash: 8 fraction digits will not fit USDC's 6, so even the fixed
//     notation above still throws. Truncation is what makes it safe.
assert.throws(() => parseUnits("0.00000081", 6), "premise: excess precision throws");
assert.equal(toAmountString(8.1e-7, 6), "0");
assert.doesNotThrow(() => parseUnits(toAmountString(8.1e-7, 6), 6));

// --- truncate, never round: rounding up invents funds in a balance comparison.
assert.equal(toAmountString(1.9999999, 6), "1.999999");
assert.equal(toAmountString("0.9999999", 6), "0.999999");
assert.notEqual(toAmountString(1.9999999, 6), "2");

// --- ordinary values are untouched
assert.equal(toAmountString(3, 6), "3");
assert.equal(toAmountString("1.5", 6), "1.5");
assert.equal(toAmountString(0.064025, 6), "0.064025");
assert.equal(toAmountString(0, 6), "0");

// --- strings that arrived already exponential
assert.equal(toAmountString("8.1e-7", 18), "0.00000081");
assert.equal(toAmountString("1e-7", 18), "0.0000001");

// --- junk degrades to "0" rather than throwing inside a transaction
assert.equal(toAmountString("", 6), "0");
assert.equal(toAmountString("abc", 6), "0");
assert.equal(toAmountString(Number.NaN, 6), "0");
assert.equal(toAmountString(Number.POSITIVE_INFINITY, 6), "0");

// --- display: dust must not read as zero, and must never read as MORE than it is.
//     (8.1e-7).toFixed(6) is "0.000001" — the round-up that invited an over-withdrawal.
assert.equal((8.1e-7).toFixed(6), "0.000001", "premise: toFixed rounds up");
assert.equal(displayAmount(8.1e-7), "<0.000001");
assert.equal(displayAmount(0), "0");
assert.equal(displayAmount(0.064025), "0.064025");

console.log("amountString.check: OK — exponential, precision clamp, truncation, display");
