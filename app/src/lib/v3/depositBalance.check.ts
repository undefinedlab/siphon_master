/**
 * A deposit must refuse early when the wallet is short — and never refuse for any other reason.
 *
 * The failure this guards: an underfunded wallet used to sail past the client, prompt an approval,
 * spend gas on it, and only then revert inside the adapter as "ERC20: transfer amount exceeds
 * balance" — an opaque message that names neither the wallet nor the amount.
 *
 * Run: bunx tsx src/lib/v3/depositBalance.check.ts
 */
import assert from "node:assert";
import { depositShortfallMessage } from "./depositV3";

const OWNER = "0x57fBC1234567890123456789012345678900267A2";
const USDC = 6;

// --- refuses only on a genuine shortfall -----------------------------------------------------
const short = depositShortfallMessage(500_000n, 0n, USDC, OWNER);
assert.ok(short, "an empty wallet must be refused before any signature");
assert.match(short!, /0\.5/, "the message must name what the deposit needs");
assert.match(short!, /holds 0\.0/, "the message must name what the wallet actually holds");
assert.match(short!, /0x57fB…67A2/, "the message must name WHICH wallet is short");
assert.match(short!, /no gas/, "the message must say nothing was signed");

assert.ok(depositShortfallMessage(500_000n, 499_999n, USDC, OWNER), "one unit short is still short");

// --- never refuses a funded wallet -----------------------------------------------------------
assert.strictEqual(
  depositShortfallMessage(500_000n, 500_000n, USDC, OWNER),
  null,
  "an exactly-funded wallet must proceed — off-by-one here blocks a legitimate deposit",
);
assert.strictEqual(
  depositShortfallMessage(500_000n, 10_000_000n, USDC, OWNER),
  null,
  "an ample balance must proceed",
);
assert.strictEqual(depositShortfallMessage(0n, 0n, USDC, OWNER), null, "zero need is never short");

// --- FAIL OPEN: an unreadable balance must never block a deposit ------------------------------
// A flaky RPC is not evidence of an empty wallet. Blocking here would strand a funded user with
// no way to deposit, which is strictly worse than letting the chain reject a bad transfer.
assert.strictEqual(
  depositShortfallMessage(500_000n, null, USDC, OWNER),
  null,
  "an unreadable balance must NOT block the deposit",
);

// --- decimals are honoured, so the numbers shown are the numbers the user recognises -----------
assert.match(
  depositShortfallMessage(1_000_000_000_000_000_000n, 0n, 18, OWNER)!,
  /needs 1\.0 /,
  "18-decimal assets must format as whole units, not wei",
);
assert.match(
  depositShortfallMessage(500_000n, 0n, USDC, OWNER)!,
  /needs 0\.5 /,
  "6-decimal USDC must not be formatted with 18 decimals",
);

console.log(
  "depositBalance.check: OK — short/exact/ample/zero decided correctly, an unreadable balance " +
    "never blocks, and 6- and 18-decimal amounts both format as human units",
);
