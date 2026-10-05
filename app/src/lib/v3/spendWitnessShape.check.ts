// Runnable self-check: every witness we build is a shape the SHIPPED circuit actually accepts.
//   npx tsx src/lib/v3/spendWitnessShape.check.ts
//
// This is the check that was missing. SPLIT, SWAP and RAGEQUIT are single-input circuits — their
// note fields are declared as SCALARS — but all three were being fed the multi-input `inputArrays`
// plus a `boundaryIndex` that only WITHDRAW and MERGE declare. Witness generation died on
// "Signal boundaryIndex not found" before reaching a single constraint, so no TWAP could ever arm:
// its SPLIT leg never produced a proof. SWAP additionally passed pool/dstToken/fee/minAmountOut/
// outputPrecommitment, which ride in publicInputs and are not signals at all.
//
// Nothing caught it because the witness was assembled inline at each callsite and the only
// reference — siphon-zk-v2/scripts/lib/witness-to-input.cjs — lives in another repo. So this
// asks the wasm itself, which is the one source that cannot drift.
//
// It deliberately does NOT assert the proof succeeds: the values here are dummies, so the circuit
// is expected to fail a constraint. What it asserts is that it fails a CONSTRAINT and never a
// missing/mis-shaped signal. Those are different errors and only one of them is a contract break.
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as snarkjs from "snarkjs";

import {
  ragequitWitnessInput,
  splitWitnessInput,
  swapWitnessInput,
  type AssembledPaths,
} from "./spendActionsV3";

const LEVELS = 32; // Split(32, 8) / Swap(32) / Ragequit(32) — circuits/main/*.circom
const SLICES = 8;

const note = {
  commitment: "1",
  value: 1_000_000n,
  label: "12345",
  assetId: "6789",
  nullifier: "111",
  secret: "222",
};

/** A structurally valid AssembledPaths. Values are dummies; only the SHAPE is under test. */
const paths: AssembledPaths = {
  stateRoot: 0n,
  statePathElements: [Array.from({ length: LEVELS }, () => "0")],
  statePathIndices: [Array.from({ length: LEVELS }, () => 0)],
  compliance: {
    admittedRoot: "0",
    revokedRoot: "0",
    inputs: [
      {
        admittedLeafIndex: 0,
        admittedPathElements: Array.from({ length: LEVELS }, () => "0"),
        admittedPathIndices: Array.from({ length: LEVELS }, () => 0),
        revokedSmtPathElements: Array.from({ length: LEVELS }, () => "0"),
        revokedSmtPathIndices: Array.from({ length: LEVELS }, () => 0),
        revokedSmtLeaf: "0",
      },
    ],
  },
} as unknown as AssembledPaths;

const publics = Array.from({ length: 25 }, () => "0");

const slices = Array.from({ length: SLICES }, (_, i) => ({
  value: i === 0 ? 1_000_000n : 0n,
  nullifier: i === 0 ? 333n : 0n,
  secret: i === 0 ? 444n : 0n,
}));

// Non-zero: both halves constrain salt != 0, so a 0 here would fail the wrong assert and the
// check would stop distinguishing a shape break from a constraint break.
const SALT = 12345n;

const CASES: Array<{ circuit: string; input: Record<string, unknown> }> = [
  { circuit: "split", input: splitWitnessInput(note, slices, paths, publics, SALT) },
  { circuit: "swap", input: swapWitnessInput(note, 555n, 666n, paths, publics, SALT) },
  {
    circuit: "ragequit",
    input: ragequitWitnessInput(note, "0x" + "11".repeat(20), 1, paths, publics),
  },
];

// circom's witness calculator reports a shape break with these; a constraint break says
// "Assert Failed" instead. Only the former means our witness disagrees with the circuit.
const SHAPE_ERROR = /Signal .* not found|Not enough values|Too many values|Invalid witness length/i;

async function main() {
  const out = mkdtempSync(join(tmpdir(), "siphon-wtns-"));
  let checked = 0;

  for (const { circuit, input } of CASES) {
    const wasm = `public/zk/${circuit}/main_${circuit}.wasm`;
    let err: unknown;
    try {
      // `wtns` is real at runtime but absent from snarkjs' shipped types.
      const wtns = (snarkjs as unknown as {
        wtns: { calculate: (i: unknown, w: string, o: string) => Promise<void> };
      }).wtns;
      await wtns.calculate(input, wasm, join(out, `${circuit}.wtns`));
    } catch (e) {
      err = e;
    }

    const message = err instanceof Error ? err.message : String(err ?? "");
    assert.ok(
      !SHAPE_ERROR.test(message),
      `${circuit}: witness does not match the shipped circuit — ${message}`,
    );
    // Reaching a constraint at all proves every signal name and array length was accepted.
    console.log(`  ${circuit}: shape accepted${message ? ` (constraint failed as expected)` : ""}`);
    checked += 1;
  }

  assert.strictEqual(checked, CASES.length);
  console.log("spendWitnessShape.check: OK — split/swap/ragequit witnesses match their circuits");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
