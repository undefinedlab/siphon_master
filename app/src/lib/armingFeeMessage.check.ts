// Guards that the arming-fee shortfall message survives friendlyTxError un-genericised (no
// framework in this repo). Run: npx tsx src/lib/armingFeeMessage.check.ts
// friendlyTxError replaces any message matching
// /insufficient funds|insufficient balance|exceeds balance|have 0\.0/i
// with a generic string — the arming-fee message must NOT trip those, or the clear text is lost.
import assert from "node:assert";

const GENERICISE = /insufficient funds|insufficient balance|exceeds balance|have 0\.0/i;
const buildMsg = (need: string, has: string, net: string) =>
  `Arming fee needs ${need} USDC in your wallet, but your ${net} wallet holds only ${has} USDC ` +
  `(the fee is charged from your wallet, not your shielded vault). Top up USDC and try again.`;

// The exact case that broke: 0.038877 USDC vs 0.25 required — note "0.038877" contains "0.0".
const m = buildMsg("0.25", "0.038877", "Base");
assert.ok(!GENERICISE.test(m), "message trips friendlyTxError → would be genericised: " + m);
// First 140 chars (friendlyTxError truncates there) must still carry the shortfall numbers.
const head = m.split(/[\n(]/)[0].slice(0, 140);
assert.ok(head.includes("0.25") && head.includes("0.038877"), "shortfall numbers dropped in first 140 chars");
// A zero balance ("0.0") must also pass.
assert.ok(!GENERICISE.test(buildMsg("0.25", "0.0", "Base")), "zero-balance message genericised");
console.log("OK — arming-fee message survives friendlyTxError and keeps the numbers");
