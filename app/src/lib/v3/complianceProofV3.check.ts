// Runnable self-check: the browser's labelCommit must equal spend-core's, exactly.
//   npx tsx src/lib/v3/complianceProofV3.check.ts
//
// PROGRAM_VERSION 5 verifies two proofs conjunctively, bound only by `labelCommit` — spend limb 24
// and compliance limb 3. If this hash disagrees with the circuit's by so much as a domain constant
// or an arity, both halves still prove locally (each is internally consistent) and the kernel
// reverts ComplianceProofFailed() on-chain, after the gas is spent. There is no cheaper place to
// catch it than here.
//
// The fixtures are the authority: siphon-zk-v2/test-vectors/*.json carry `labelSalt` and the
// `expectedCompliancePublic` vector that the Rust spend-core produced, and the SAME files are what
// the circuits are tested against. Matching them matches the deployed verifiers.
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";

import { labelCommit, compliancePublics, MAX_INPUTS, randomLabelSalt } from "./complianceProofV3";
import { PROGRAM_VERSION_V3 } from "./configV3";

/** Where the ceremony worktree's vectors live. Overridable so this runs from any checkout. */
const VECTORS =
  process.env.SIPHON_ZK_VECTORS ??
  "/private/tmp/claude-501/-Users-swarnimraj-Siphon/56cf889b-d75a-4c13-8141-68993bcb3b4a/scratchpad/zk-ceremony/test-vectors";

interface Vector {
  inputCount: number;
  labelSalt: string;
  admittedRoot: string;
  revokedRoot: string;
  inputs: Array<{ inLabel: string }>;
  expectedPublic: string[];
  expectedCompliancePublic: string[];
}

// Every arity the deployed compliance verifiers cover that has a vector: 1 (split/swap), 2, 3, 6.
// The `-fail` vectors are deliberately excluded — they carry no `expectedPublic` to compare against.
const NAMES = [
  "split-ok.json",
  "swap-ok.json",
  "merge-m2-ok.json",
  "withdraw-w3-ok.json",
  "withdraw-w3-zero-change-ok.json",
  "merge-m6-ok.json",
];

async function main() {
  const found = NAMES.filter((n) => existsSync(`${VECTORS}/${n}`));
  if (found.length === 0) {
    // Not a pass. A silent skip here is how a hash drift ships.
    throw new Error(
      `complianceProofV3.check: no vectors under ${VECTORS} — set SIPHON_ZK_VECTORS to the ` +
        `siphon-zk-v2 test-vectors directory (ceremony worktree, PUBLIC_WIDTH=25).`,
    );
  }

  for (const name of found) {
    const v = JSON.parse(readFileSync(`${VECTORS}/${name}`, "utf8")) as Vector;
    const labels = v.inputs.map((i) => BigInt(i.inLabel));
    const salt = BigInt(v.labelSalt);

    const commit = await labelCommit(v.inputCount, labels, salt);

    // 1) our hash == spend-core's, as carried in the spend vector's limb 24
    assert.strictEqual(
      commit.toString(),
      v.expectedPublic[24],
      `${name}: labelCommit != spend limb 24 — the two halves would not bind`,
    );

    // 2) …and == the compliance vector's limb 3, which is the other side of the same binding
    assert.strictEqual(
      commit.toString(),
      v.expectedCompliancePublic[3],
      `${name}: labelCommit != compliance limb 3`,
    );

    // 3) the whole 5-limb compliance vector, not just the commit
    const publics = compliancePublics(
      v.inputCount,
      BigInt(v.admittedRoot),
      BigInt(v.revokedRoot),
      commit,
    );
    assert.deepStrictEqual(
      publics,
      v.expectedCompliancePublic.map((x) => BigInt(x).toString()),
      `${name}: compliance public vector mismatch`,
    );
    assert.strictEqual(publics[4], String(PROGRAM_VERSION_V3), `${name}: programVersion limb`);

    console.log(`  ${name}: labelCommit + 5-limb vector match spend-core (n=${v.inputCount})`);
  }

  // Padding rule: the commit is hashed at MAX_INPUTS with inactive slots zeroed, which is what lets
  // an exact-N compliance circuit reproduce the padded spend circuit's value. Passing the labels
  // already zero-padded must therefore be indistinguishable from passing only the active ones.
  const salt = 424242n;
  const active = [11n, 22n];
  const padded = [...active, ...Array(MAX_INPUTS - active.length).fill(0n)];
  assert.strictEqual(
    (await labelCommit(2, active, salt)).toString(),
    (await labelCommit(2, padded, salt)).toString(),
    "labelCommit must pad to MAX_INPUTS, so explicit zero padding changes nothing",
  );

  // inputCount is hashed, so the same labels at a different arity must NOT collide — otherwise a
  // proof could be replayed against a different-arity verifier.
  assert.notStrictEqual(
    (await labelCommit(2, active, salt)).toString(),
    (await labelCommit(3, active, salt)).toString(),
    "labelCommit must bind inputCount",
  );

  // Both circuits constrain salt != 0; a zero must fail here, not at fire time.
  await assert.rejects(
    async () => labelCommit(1, [7n], 0n),
    /non-zero/,
    "a zero salt must be rejected",
  );

  const s1 = randomLabelSalt();
  assert.ok(s1 > 0n, "randomLabelSalt must be non-zero");
  assert.notStrictEqual(s1, randomLabelSalt(), "randomLabelSalt must not be constant");

  console.log("complianceProofV3.check: OK — labelCommit agrees with spend-core on every vector");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
