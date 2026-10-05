// Runnable self-check: funding a strategy from a larger vault note conserves value exactly.
//   npx tsx src/lib/v3/spendFromBalance.check.ts
//
// The SPLIT circuit constrains Σ outputs == input value. A wei lost to integer division does not
// silently vanish — it fails to prove, minutes in, after the arming fee has been charged. So the
// arithmetic that decides the slice values is worth pinning down on its own, away from a signer,
// an ASP and a prover.
//
// The other thing under test is the slot budget: change occupies one of the 8 split outputs, so a
// strategy funded from a larger note can carry one fewer leg. Getting that wrong overflows the
// fixed-width slice array inside the prover instead of erroring here.
import assert from "node:assert";

const SPLIT_OUTPUTS = 8;

/** Mirrors buildV3StrategyLegs: even slices, remainder onto the first, change as a trailing slot. */
function planSplit(noteValue: bigint, spendValue: bigint, sliceCount: number): bigint[] {
  const change = noteValue - spendValue;
  if (spendValue <= 0n || change < 0n) throw new Error("cannot spend more than the note holds");
  const maxSlices = SPLIT_OUTPUTS - (change > 0n ? 1 : 0);
  if (sliceCount < 1 || sliceCount > maxSlices) throw new Error(`sliceCount must be 1..${maxSlices}`);

  const per = spendValue / BigInt(sliceCount);
  const remainder = spendValue - per * BigInt(sliceCount);
  const slices = Array.from({ length: sliceCount }, (_, i) => (i === 0 ? per + remainder : per));
  return change > 0n ? [...slices, change] : slices;
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

// The case that motivated all of this: a 0.010 ETH vault note funding a 0.001 ETH TWAP.
{
  const note = 10_000_000_000_000_000n;
  const spend = 1_000_000_000_000_000n;
  const out = planSplit(note, spend, 3);
  assert.strictEqual(out.length, 4, "3 slices + change");
  assert.strictEqual(sum(out), note, "outputs must sum to the whole note");
  assert.strictEqual(sum(out.slice(0, 3)), spend, "the armed slices must sum to the order");
  assert.strictEqual(out[3], note - spend, "change is the leftover");
}

// Indivisible amounts: the remainder rides on slice 0 rather than being dropped.
{
  const note = 1_000_000_000_000_000_001n;
  const spend = 100n;
  const out = planSplit(note, spend, 7); // 100/7 = 14 r 2
  assert.strictEqual(sum(out), note);
  assert.strictEqual(sum(out.slice(0, 7)), spend);
  assert.strictEqual(out[0], 16n, "remainder lands on the first slice");
  assert.strictEqual(out[1], 14n);
}

// Exact-size note: no change slot, so all 8 outputs stay available.
{
  const note = 800n;
  const out = planSplit(note, note, 8);
  assert.strictEqual(out.length, 8);
  assert.strictEqual(sum(out), note);
  assert.ok(out.every((v) => v === 100n));
}

// Slot budget: 8 slices is fine spending the whole note, and one too many with change.
assert.throws(() => planSplit(900n, 800n, 8), /1\.\.7/, "change must cost a slot");
assert.throws(() => planSplit(100n, 200n, 1), /cannot spend more/, "cannot overspend a note");
assert.throws(() => planSplit(100n, 0n, 1), /cannot spend more/, "cannot spend nothing");

// Single-leg carve: [amount, change], which is what buildV3Single asks splitNoteV3 for.
{
  const note = 10_000_000n;
  const spend = 2_500_001n;
  const out = planSplit(note, spend, 1);
  assert.deepStrictEqual(out, [spend, note - spend]);
  assert.strictEqual(sum(out), note);
}

console.log("spendFromBalance.check: OK — splits conserve value and respect the 8-slot budget");
