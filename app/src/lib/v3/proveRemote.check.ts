// Runnable self-check: the witness we send the enclave rebuilds our Circom input EXACTLY.
//   npx tsx src/lib/v3/proveRemote.check.ts
//
// toProtocolWitness() is a hand-written inverse of siphon-zk-v2/scripts/lib/witness-to-input.cjs,
// which lives in another repo and is not imported by the app at runtime. A transposed field or a
// dropped key would not fail type-checking, would not fail at the network boundary, and would
// surface as "Signal X not found" inside witness generation — after the user confirmed a
// withdrawal. So this asserts the round trip against the REAL converter, per action.
import assert from "node:assert";
import { createRequire } from "node:module";

import { ACTION, toProtocolWitness, type SpendAction } from "./proveRemote";

const require_ = createRequire(import.meta.url);

// The 25-limb (PROGRAM_VERSION 5) converter. The sibling siphon-zk-v2 checkout is normally on
// fix/asp-v2-ragequit-and-smt, which is 26 limbs and whose withdrawal circuit declares no
// admitted*/revoked* signals at all — so this round trip compares against a DIFFERENT protocol and
// fails on every action. Point SIPHON_ZK_LIB at a 25-limb tree (the ceremony worktree) to run it.
const ZK_LIB =
  process.env.SIPHON_ZK_LIB ??
  "/private/tmp/claude-501/-Users-swarnimraj-Siphon/56cf889b-d75a-4c13-8141-68993bcb3b4a/scratchpad/zk-ceremony/scripts/lib/witness-to-input.cjs";
const { witnessToCircomInput } = require_(ZK_LIB);

{
  const { PUBLIC_WIDTH } = require_(ZK_LIB.replace("witness-to-input.cjs", "circuits.cjs"));
  if (PUBLIC_WIDTH !== 25) {
    throw new Error(
      `proveRemote.check: ${ZK_LIB} is a ${PUBLIC_WIDTH}-limb tree; v5 is 25. ` +
        `Set SIPHON_ZK_LIB to the ceremony (25-limb) checkout.`,
    );
  }
}

// Non-zero: both circuit halves constrain salt != 0, and toProtocolWitness rejects a missing or
// zero one — a witness without it fails INSIDE the enclave, after the user confirmed the spend.
const SALT = "8877665544332211";
const PAYEE_HEX = "1234567890abcdef1234567890abcdef12345678";
const PAYEE_BYTES = Array.from({ length: 20 }, (_, i) =>
  parseInt(PAYEE_HEX.slice(i * 2, i * 2 + 2), 16),
);
const path32 = (seed: number) => Array.from({ length: 32 }, (_, j) => String(seed * 100 + j));
const publics = Array.from({ length: 25 }, (_, i) => String(i));

/** One input slot as it appears in Circom input, indexed so a transpose bug cannot go unnoticed. */
const slot = (i: number) => ({
  inValue: String(1000 + i),
  inNullifier: String(2000 + i),
  inSecret: String(3000 + i),
  inLabel: String(4000 + i),
  inAssetId: String(5000 + i),
  admittedLeafIndex: String(6000 + i),
  statePathElements: path32(1 + i),
  statePathIndices: path32(2 + i),
  admittedPathElements: path32(3 + i),
  admittedPathIndices: path32(4 + i),
  revokedSmtPathElements: path32(5 + i),
  revokedSmtPathIndices: path32(6 + i),
  revokedSmtLeaf: String(7000 + i),
});

/** Transpose n slots into the array-per-field shape the multi-input circuits declare. */
function arrays(n: number) {
  const s = Array.from({ length: n }, (_, i) => slot(i));
  const key = <K extends keyof ReturnType<typeof slot>>(k: K) => s.map((x) => x[k]);
  return {
    inValue: key("inValue"),
    inNullifier: key("inNullifier"),
    inSecret: key("inSecret"),
    inLabel: key("inLabel"),
    inAssetId: key("inAssetId"),
    statePathElements: key("statePathElements"),
    statePathIndices: key("statePathIndices"),
    admittedLeafIndex: key("admittedLeafIndex"),
    admittedPathElements: key("admittedPathElements"),
    admittedPathIndices: key("admittedPathIndices"),
    revokedSmtPathElements: key("revokedSmtPathElements"),
    revokedSmtPathIndices: key("revokedSmtPathIndices"),
    revokedSmtLeaf: key("revokedSmtLeaf"),
  };
}

function roundTrip(
  name: string,
  action: SpendAction,
  inputCount: number,
  input: Record<string, unknown>,
  rawPayeeHex?: string,
) {
  const w = toProtocolWitness(action, inputCount, input, { rawPayeeHex });
  assert.deepStrictEqual(
    witnessToCircomInput(w),
    input,
    `${name}: witness does not rebuild the Circom input the browser would have proved`,
  );
  console.log(`  ok  ${name}`);
}

console.log("proveRemote round-trip:");

// WITHDRAW — the arity that matters most: 6 inputs is the 144MB key nobody can download.
for (const n of [1, 2, 6]) {
  roundTrip(
    `withdraw${n}`,
    ACTION.withdraw,
    n,
    {
      publicInputs: publics,
      labelCommitSalt: SALT,
      boundaryIndex: String(n - 1),
      outNullifier: "9001",
      outSecret: "9002",
      ...arrays(n),
      rawPayee: PAYEE_BYTES,
    },
    PAYEE_HEX,
  );
}

// MERGE — same shape as withdraw but no payee (nothing exits).
for (const n of [2, 6]) {
  roundTrip(`merge${n}`, ACTION.merge, n, {
    publicInputs: publics,
    labelCommitSalt: SALT,
    boundaryIndex: String(n - 1),
    outNullifier: "9001",
    outSecret: "9002",
    ...arrays(n),
  });
}

// SWAP / SPLIT / RAGEQUIT — single-input circuits declaring SCALARS, not arrays. This is exactly
// the class of bug spendWitnessShape.check.ts was written for; assert it cannot come back.
roundTrip("swap", ACTION.swap, 1, {
  publicInputs: publics,
  labelCommitSalt: SALT,
  ...slot(0),
  outNullifier: "9001",
  outSecret: "9002",
  destLabel: "4000",
});

roundTrip("split", ACTION.split, 1, {
  publicInputs: publics,
  labelCommitSalt: SALT,
  ...slot(0),
  outValue: ["11", "22", "33"],
  outNullifier: ["44", "55", "66"],
  outSecret: ["77", "88", "99"],
});

roundTrip(
  "ragequit",
  ACTION.ragequit,
  1,
  {
    publicInputs: publics,
    branch: "1",
    inValue: slot(0).inValue,
    inNullifier: slot(0).inNullifier,
    inSecret: slot(0).inSecret,
    inLabel: slot(0).inLabel,
    inAssetId: slot(0).inAssetId,
    statePathElements: slot(0).statePathElements,
    statePathIndices: slot(0).statePathIndices,
    revokedSmtPathElements: slot(0).revokedSmtPathElements,
    revokedSmtPathIndices: slot(0).revokedSmtPathIndices,
    revokedSmtLeaf: slot(0).revokedSmtLeaf,
    rawPayee: PAYEE_BYTES,
  },
  PAYEE_HEX,
);

// A withdraw witness must be REJECTED without a payee rather than silently proving to address 0.
assert.throws(
  () => toProtocolWitness(ACTION.withdraw, 1, { publicInputs: publics, labelCommitSalt: SALT, ...arrays(1) }),
  /requires rawPayeeHex/,
  "withdraw without a payee must throw",
);
console.log("  ok  withdraw without payee throws");

// COMPLIANCE_CIRCUIT_SPLIT: a spend witness without the binding salt reaches the enclave and dies
// there ("labelSalt required and MUST be non-zero"), which the user sees as a 502 with the local
// prover never attempted. Reject it here instead.
for (const bad of [undefined, "0"]) {
  assert.throws(
    () =>
      toProtocolWitness(
        ACTION.merge,
        2,
        { publicInputs: publics, labelCommitSalt: bad, boundaryIndex: "1", outNullifier: "1", outSecret: "2", ...arrays(2) },
      ),
    /labelCommitSalt/,
    `merge with labelCommitSalt=${String(bad)} must throw`,
  );
}
console.log("  ok  missing/zero labelCommitSalt throws");

// RAGEQUIT is the exception — no compliance proof, no salt, and it must NOT be rejected for one.
assert.doesNotThrow(
  () =>
    toProtocolWitness(ACTION.ragequit, 1, {
      publicInputs: publics,
      branch: "1",
      ...arrays(1),
      rawPayee: PAYEE_BYTES,
    }, { rawPayeeHex: PAYEE_HEX }),
  "ragequit must not require a labelCommitSalt",
);
console.log("  ok  ragequit needs no salt");

console.log("proveRemote: all round-trips exact");
