// Runnable self-check for the v3 strategy-leg slicing — no test framework in this repo.
//   npx tsx src/lib/v3/buildV3StrategyLegs.check.ts
//
// Only the pure slicing arithmetic is exercised here; the rest of buildV3StrategyLegs is I/O
// (split tx, note store, enclave arming). That arithmetic is worth pinning on its own because both
// of its invariants fail SILENTLY in the direction that matters:
//
//   - Σ slices must equal the input note value EXACTLY. The SPLIT circuit constrains it, so a
//     dropped remainder does not lose funds — it fails to prove, after the user has already paid
//     an arming fee, and reads as a proving bug rather than an arithmetic one.
//   - inactive slots must be all-zero (value AND nullifier AND secret). A stray nonzero secret in
//     an unused slot mints a note nobody records, which is the "shielded but invisible" failure.
import assert from "node:assert";

const SPLIT_OUTPUTS = 8;

/** Mirrors the slicing in buildV3StrategyLegs. Kept in step by the assertions below. */
function slice(value: bigint, sliceCount: number) {
  const per = value / BigInt(sliceCount);
  const remainder = value - per * BigInt(sliceCount);
  const values = Array.from({ length: sliceCount }, (_, i) => (i === 0 ? per + remainder : per));
  return [
    ...values.map((v) => ({ value: v, active: true })),
    ...Array.from({ length: SPLIT_OUTPUTS - sliceCount }, () => ({ value: 0n, active: false })),
  ];
}

function main() {
  // ---- Σ slices == input, including indivisible amounts --------------------------------------
  for (const [value, n] of [
    [1000n, 4],
    [1000n, 3], // 1000/3 = 333 r1 — the remainder case
    [1n, 1],
    [7n, 5], // fewer units than slices in most slots
    [10n ** 18n + 7n, 8],
  ] as Array<[bigint, number]>) {
    const s = slice(value, n);
    const sum = s.reduce((a, x) => a + x.value, 0n);
    assert.strictEqual(sum, value, `Σ slices != input for ${value}/${n} — SPLIT would fail to prove`);
    assert.strictEqual(s.length, SPLIT_OUTPUTS, "SPLIT is fixed-width: always 8 slots");
    assert.strictEqual(s.filter((x) => x.active).length, n, "wrong active slot count");
  }

  // ---- the remainder lands on exactly one slice ----------------------------------------------
  const r = slice(1000n, 3);
  assert.strictEqual(r[0].value, 334n, "remainder must go to the first slice");
  assert.strictEqual(r[1].value, 333n);
  assert.strictEqual(r[2].value, 333n);

  // ---- inactive slots are zero-valued ---------------------------------------------------------
  const padded = slice(100n, 2);
  for (let i = 2; i < SPLIT_OUTPUTS; i++) {
    assert.strictEqual(padded[i].value, 0n, `slot ${i} must be zero — it is not an active slice`);
    assert.strictEqual(padded[i].active, false);
  }

  // ---- no slice may be zero-valued while active ------------------------------------------------
  // A zero-valued ACTIVE slice would arm a leg that swaps nothing: it costs a proof and an
  // arming fee and can never produce an output note.
  const tight = slice(3n, 3);
  for (const s of tight.filter((x) => x.active)) {
    assert.ok(s.value > 0n, "an active slice must carry value");
  }

  console.log("buildV3StrategyLegs slicing: OK");
}

main();
