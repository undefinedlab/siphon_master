// Runnable self-check for note amount-unit resolution — no test framework in this repo.
//   npx tsx src/lib/noteAmount.check.ts
//
// Worth pinning because both failure directions are silent and expensive:
//   - reading a v3 (wei) row as a human decimal inflated it by 1e18, so reconstructLeaf disagreed
//     with the stored commitment and localNoteStore DISCARDED a real note as a "corrupt row";
//   - reading a v2 (human) row as wei shrinks it by 1e18, producing a note worth dust.
// Neither throws. The first loses funds from view, the second from the balance.
import assert from "node:assert";

import { amountIsWei, localNoteAmountToHuman, noteAmountToHuman, noteAmountToWei } from "./noteAmount";

function main() {
  // ---- v3 rows: amount is wei, identified by the v3- vaultId ---------------------------------
  const v3 = { amount: "1000000000000000", vault_id: "v3-0x50Db1b65fe56de4015912FD3E1AdC1bccFB08151" };
  assert.strictEqual(amountIsWei(v3), true);
  assert.strictEqual(noteAmountToWei(v3, 18), 1000000000000000n);
  // The bug in the dashboard: this rendered as 1000000000000000.000000 ETH.
  assert.strictEqual(noteAmountToHuman(v3, 18), 0.001);

  // ---- v2 rows: amount is a human decimal ------------------------------------------------------
  const v2 = { amount: "0.001", vault_id: null };
  assert.strictEqual(amountIsWei(v2), false);
  assert.strictEqual(noteAmountToWei(v2, 18), 1000000000000000n);
  assert.strictEqual(noteAmountToHuman(v2, 18), 0.001);

  // A v2 row with no decimal point is still human — the vaultId is what decides, not the shape.
  const v2whole = { amount: "5", vault_id: "hard-asp-r2" };
  assert.strictEqual(amountIsWei(v2whole), false);
  assert.strictEqual(noteAmountToWei(v2whole, 6), 5_000_000n, "5 USDC must be 5e6, not 5 wei");

  // A decimal point is conclusive even on a v3 row: wei is always an integer.
  assert.strictEqual(amountIsWei({ amount: "0.5", vault_id: "v3-0xabc" }), false);

  // ---- USDC (6 decimals) — the wrong-decimals case, not just wrong-units ----------------------
  const v3usdc = { amount: "2500000", vault_id: "v3-0xabc" };
  assert.strictEqual(noteAmountToHuman(v3usdc, 6), 2.5);

  // ---- fail closed, never silently zero-or-wrong ----------------------------------------------
  // An UNTAGGED row on a v3 chain is WEI. Reading it as a human decimal ran parseUnits over an
  // already-wei amount and inflated it by 10^decimals: a real 0.01 USDC deposit (5000000, 6dp)
  // displayed as 5000 USDC. Rows arrive untagged whenever a v3 note is written through the v2
  // postCommitment path.
  assert.strictEqual(
    noteAmountToWei({ amount: "5000000", vault_id: null, isV3: true }, 6),
    5_000_000n,
    "untagged row from the v3 sync must be read as wei, not re-scaled",
  );
  // …but the same row on a NON-v3 chain is still a human decimal — the v2 reading must survive.
  assert.strictEqual(
    noteAmountToWei({ amount: "0.01", vault_id: null }, 6),
    10_000n,
    "a v2 row (no isV3) stays a human decimal",
  );

  assert.strictEqual(noteAmountToWei({ amount: "", vault_id: "v3-0xabc" }, 18), null);
  assert.strictEqual(noteAmountToWei({ amount: "not-a-number", vault_id: null }, 18), null);
  assert.strictEqual(noteAmountToWei({ amount: "1e15", vault_id: "v3-0xabc" }, 18), null);

  // ---- localStorage rows: v3 carries `value` (wei), v2 carries `amount` (human) ---------------
  assert.strictEqual(localNoteAmountToHuman({ value: "1000000000000000" }, 18), 0.001);
  assert.strictEqual(localNoteAmountToHuman({ amount: "0.001" }, 18), 0.001);
  // `value` wins when both are present — it is the exact wei the circuit binds.
  assert.strictEqual(localNoteAmountToHuman({ value: "2500000", amount: "999" }, 6), 2.5);
  assert.strictEqual(localNoteAmountToHuman({}, 18), 0);

  console.log("noteAmount.check: OK — v2 human and v3 wei rows both resolve to the same value");
}

main();
