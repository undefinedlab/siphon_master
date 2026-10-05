// Runnable self-check: the planner's insufficient-funds throw must survive the round trip back to
// the units the user typed.
//   npx tsx src/lib/v3/planWithdrawV3.check.ts
//
// The message is produced in one place and parsed in another, so the regex is exactly the kind of
// thing that silently stops matching when someone rewords the throw. It is pinned here against the
// real thrower rather than a copied literal — reword the message and this fails immediately, which
// is the point: a miss degrades to "Transaction failed: planWithdraw: insufficient funds — have
// 24238, need 54239 of asset 7490717508934632905…" in a toast.
import assert from "node:assert";
import {
  planWithdraw,
  parseInsufficientFunds,
  parseTooManyNotes,
  type PlannerNote,
} from "./planWithdrawV3";

const USDC = "74907175089346329057477646133109385276" + "0741783827";

let seq = 0;
const note = (value: bigint, label?: string): PlannerNote => ({
  commitment: "0x1", value, label: label ?? `0x${++seq}`, assetId: USDC,
  nullifier: "0x2", secret: "0x3",
});

function main() {
  // The exact Base case: 0.024238 USDC held, 0.054239 needed (0.024239 out + 0.03 flat gas).
  let thrown = "";
  try {
    planWithdraw([note(24238n)], 54239n, USDC);
    assert.fail("planWithdraw should have refused");
  } catch (e) {
    thrown = (e as Error).message;
  }

  const parsed = parseInsufficientFunds(thrown);
  assert.ok(parsed, `parser must match the thrower's own message, got: ${thrown}`);
  assert.strictEqual(parsed.have, 24238n);
  assert.strictEqual(parsed.need, 54239n);

  // 6-decimal rendering is what makes it readable; 24238 minor units is 0.024238 USDC.
  const human = (v: bigint) => (Number(v) / 1e6).toFixed(6);
  assert.strictEqual(human(parsed.have), "0.024238");
  assert.strictEqual(human(parsed.need), "0.054239");

  // Every OTHER planner error must pass through untouched — swallowing an unrelated failure into
  // "not enough funds" would send the user to deposit more money to fix an unrelated bug.
  for (const other of [
    "planWithdraw: no spendable notes for asset 123",
    "planWithdraw: target needs 7 notes but MAX_INPUTS is 6 — merge notes first",
    "execution reverted (unknown custom error)",
  ]) {
    assert.strictEqual(parseInsufficientFunds(other), null, `must not match: ${other}`);
  }

  // The too-many-notes throw must parse back, because withdraw now MERGES on it instead of dead
  // ending. A drift between message and regex would silently restore the dead end.
  // Seven notes from seven different deposits — distinct labels, so MAX_INPUTS is what bites.
  const many = Array.from({ length: 7 }, (_, i) => note(10000n, `0xdep${i}`));
  let tooMany: string | null = null;
  try {
    planWithdraw(many, 70000n, USDC);
  } catch (e) {
    tooMany = e instanceof Error ? e.message : String(e);
  }
  assert.ok(tooMany, "7 notes for the full balance must exceed MAX_INPUTS");
  assert.deepStrictEqual(parseTooManyNotes(tooMany!), { needed: 7, max: 6 });
  assert.strictEqual(parseTooManyNotes("planWithdraw: no spendable notes for asset 123"), null);

  // A sufficient balance still plans normally — the check above must not have broken selection.
  const plan = planWithdraw([note(60000n)], 54239n, USDC);
  assert.strictEqual(plan.primaryValue, 54239n);
  assert.strictEqual(plan.secondaryValue, 60000n - 54239n);

  // PROGRAM_VERSION 5 permits several notes descended from one deposit to be spent together.
  // The nullifiers remain distinct, which is the actual double-spend invariant.
  const sameLabel = [
    note(387n, "0xdeadbeef"),
    note(648n, "0xdeadbeef"),
    note(39n, "0xdeadbeef"),
  ];
  const sameLabelPlan = planWithdraw(sameLabel, 1074n, USDC);
  assert.strictEqual(sameLabelPlan.inputCount, 3);
  assert.strictEqual(sameLabelPlan.primaryValue, 1074n);
  assert.strictEqual(sameLabelPlan.secondaryValue, 0n);

  // Distinct labels must still combine — this is the whole point of multi-note selection.
  const twoDeposits = [note(400n, "0xaaa"), note(300n, "0xbbb")];
  const combined = planWithdraw(twoDeposits, 700n, USDC);
  assert.strictEqual(combined.inputCount, 2);
  assert.strictEqual(combined.primaryValue, 700n);

  console.log(
    "planWithdrawV3.check: OK — insufficient-funds parses back to 0.024238 have / 0.054239 need, " +
      "3 unrelated errors pass through, too-many-notes parses back to 7/6, and both same-label " +
      "and distinct-label notes combine under PROGRAM_VERSION 5",
  );
}

main();
