// Runnable self-check for v3 deposit screening classification — no test framework in this repo.
//   npx tsx src/lib/v3/depositScreeningV3.check.ts
//
// Guards the two things that decide whether a user can get revoked funds back at all: that
// revocation is never masked by admission, and that an unreachable ASP does not invent a state.
import assert from "node:assert";

import { humanAmount, screeningPhase } from "./depositScreeningV3";

// admitted, clean -> no row (privately spendable)
assert.equal(screeningPhase({ admitted: true, revoked: false }), null);

// not yet admitted -> "checking"; normal for the ~5 min admit bus after a deposit
assert.equal(screeningPhase({ admitted: false, revoked: false }), "checking");

// revoked -> "flagged", and revocation must WIN over admission. A label admitted earlier and
// revoked later is flagged; reading it as admitted would hide the ragequit control entirely.
assert.equal(screeningPhase({ admitted: false, revoked: true }), "flagged");
assert.equal(screeningPhase({ admitted: true, revoked: true }), "flagged");

// ASP unreachable -> no row, rather than a fabricated "checking" indistinguishable from a real one
assert.equal(screeningPhase(null), null);

// Amounts are rendered from minor units; a wrong scale here misstates what is at stake.
assert.equal(humanAmount(3000000n, 6), "3");            // the "3 USDC, not 3 million" case
assert.equal(humanAmount(1n, 6), "0.000001");
assert.equal(humanAmount(0n, 6), "0");
assert.equal(humanAmount(1500000n, 6), "1.5");
assert.equal(humanAmount(10n ** 18n, 18), "1");
assert.equal(humanAmount(810000000000n, 18), "0.00000081");  // the 8.1e-7 withdraw balance

console.log("depositScreeningV3.check: OK — phase classification and amount scaling");
