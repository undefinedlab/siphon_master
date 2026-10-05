/**
 * The relay fee must never look like a blocked withdrawal, and must never be invented.
 *
 * Run: bunx tsx src/lib/v3/withdrawCredit.check.ts
 */
import assert from "node:assert";
import { needsTopUp, formatCredit, topUpShortfall, affordableTopUp, type WithdrawCredit } from "./withdrawCreditV3";

const base: WithdrawCredit = {
  enabled: true, chainId: 8453, feeWei: 50_000n, balanceWei: 0n,
  collector: "0x5830A431E6866B8F8a605625b0713D8190FB06bA", asset: "USDC", decimals: 6,
};

// Short balance is the only case that should prompt.
assert.ok(needsTopUp({ ...base, balanceWei: 0n }), "empty balance must prompt a top-up");
assert.ok(needsTopUp({ ...base, balanceWei: 49_999n }), "one unit short must still prompt");
assert.ok(!needsTopUp({ ...base, balanceWei: 50_000n }), "exact balance must NOT prompt");
assert.ok(!needsTopUp({ ...base, balanceWei: 10_000_000n }), "ample balance must not prompt");

// A relayer that charges nothing must never make the UI ask for money.
assert.ok(!needsTopUp({ ...base, enabled: false, balanceWei: 0n }), "disabled fee must not prompt");
assert.ok(!needsTopUp({ ...base, feeWei: 0n, balanceWei: 0n }), "zero fee must not prompt");

// An unreachable endpoint returns null. That must read as "no fee to show", never as "blocked" —
// the withdraw button stays usable, because the fee is a convenience charge and the exit is not
// gated on it.
assert.ok(!needsTopUp(null), "unknown credit state must not block the withdrawal");

assert.strictEqual(formatCredit(50_000n), "0.05");
assert.strictEqual(formatCredit(1_234_567n), "1.234567");
assert.strictEqual(formatCredit(0n), "0.0");

// A wallet that cannot cover the top-up is told so in plain words, before any transaction is built.
assert.strictEqual(topUpShortfall(1_000_000n, 1_000_000n, "Arbitrum One"), null, "exact balance can pay");
const short = topUpShortfall(7_686n, 1_000_000n, "Arbitrum One");
assert.ok(short?.includes("needs 1.0 USDC on Arbitrum One"), "shortfall names the amount and chain");
assert.ok(short?.includes("holds 0.007686"), "shortfall names what the wallet has");

// A wallet just short of the bulk top-up buys what it can afford in whole withdrawals, not nothing:
// 0.99082 USDC against a 1.00 top-up at 0.05 per relay is 19 relays (0.95), the case that failed.
assert.strictEqual(affordableTopUp(2_000_000n, 1_000_000n, 50_000n), 1_000_000n, "covered → full amount");
assert.strictEqual(affordableTopUp(990_820n, 1_000_000n, 50_000n), 950_000n, "short → whole fees it can afford");
assert.strictEqual(affordableTopUp(7_686n, 1_000_000n, 50_000n), 0n, "cannot afford one relay → nothing");
assert.strictEqual(affordableTopUp(7_686n, 1_000_000n, 0n), 0n, "zero fee never divides");

console.log(
  "withdrawCredit.check: OK — prompts only when enabled, priced and short; a disabled, free or " +
    "unreachable relayer never blocks a withdrawal",
);
