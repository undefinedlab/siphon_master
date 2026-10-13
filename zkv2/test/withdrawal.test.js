"use strict";

/**
 * PROTOCOL withdraw1 (25-limb) prove/verify invariants.
 * Artifacts: `npm run build` → artifacts/withdraw1/
 */
const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");

const ROOT = path.resolve(__dirname, "..");
const EMPTY_SMT = JSON.parse(
  fs.readFileSync(path.join(ROOT, "test-vectors/smt/empty-subtrees.json"), "utf8"),
);

const ARTIFACT_BASES = [
  process.env.PROTOCOL_ARTIFACTS_DIR,
  path.join(ROOT, "artifacts"),
].filter(Boolean);

function firstExisting(relativePath) {
  for (const base of ARTIFACT_BASES) {
    const candidate = path.join(base, relativePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(ARTIFACT_BASES[0], relativePath);
}

function resolveWithdraw1() {
  const wasm = firstExisting("withdraw1/withdraw1.wasm");
  const zkey = firstExisting("withdraw1/zkey_final.zkey");
  const vkey = firstExisting("withdraw1/verification_key.json");
  return { wasm, zkey, vkey };
}

const { wasm: WASM, zkey: ZKEY, vkey: VKEY } = resolveWithdraw1();
const ARTIFACTS_PRESENT = [WASM, ZKEY, VKEY].every((p) => p && fs.existsSync(p));

let poseidon;
let F;

async function hash(inputs) {
  if (!poseidon) {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  }
  return BigInt(F.toObject(poseidon(inputs.map((x) => BigInt(x)))));
}

async function commitment(amount, label, assetId, nullifier, secret) {
  return hash([await hash([amount, label, assetId]), await hash([nullifier, secret])]);
}

async function oneLeafWitness(leaf) {
  const pathElements = [];
  const pathIndices = [];
  let zero = 0n;
  let root = BigInt(leaf);
  for (let level = 0; level < 32; level++) {
    pathElements.push(zero);
    pathIndices.push(0);
    root = await hash([root, zero]);
    zero = await hash([zero, zero]);
  }
  return { root, pathElements, pathIndices };
}

function smtPathIndicesFromKey(key) {
  const k = BigInt(key);
  const bits = [];
  for (let j = 0; j < 32; j++) {
    bits.push(Number((k >> (253n - BigInt(j))) & 1n));
  }
  return bits;
}

function emptySmtPath(key) {
  const pathElements = [];
  for (let i = 0; i < 32; i++) {
    pathElements.push(EMPTY_SMT.EMPTY_SUBTREE[String(i)]);
  }
  return {
    pathElements,
    pathIndices: smtPathIndicesFromKey(key),
    root: EMPTY_SMT.EMPTY_REVOKED_ROOT,
  };
}

async function evmPayeeId(rawPayeeBytes) {
  let payeeField = 0n;
  for (let i = 0; i < 20; i++) {
    payeeField += BigInt(rawPayeeBytes[i]) << BigInt(8 * (19 - i));
  }
  return hash([4n, payeeField]);
}

async function validWithdraw1Input(opts = {}) {
  const inValue = 10_000_000n;
  // Fractional change (PROGRAM_VERSION 4, §6.1): primary may be any positive value ≤ inValue;
  // secondary = inValue - primary is the change note carved from the boundary note.
  const primaryValue = opts.primaryValue !== undefined ? opts.primaryValue : inValue;
  const secondaryValue = inValue - primaryValue;
  const inLabel = 123456789n;
  const inAssetId = 4096n; // address(0x1000) fixture token
  const inNullifier = 111111n;
  const inSecret = 222222n;
  const outNullifier = 333333n;
  const outSecret = 444444n;
  const payeeAddr = 0x1234567890abcdef1234567890abcdef12345678n;
  const rawPayee = Array.from({ length: 20 }, (_, i) =>
    Number((payeeAddr >> BigInt(8 * (19 - i))) & 0xffn),
  );
  const payeeId = await evmPayeeId(rawPayee);

  const leaf = await commitment(inValue, inLabel, inAssetId, inNullifier, inSecret);
  const state = await oneLeafWitness(leaf);
  const asp = await oneLeafWitness(inLabel);
  const smtKey = await hash([1n, inLabel]);
  const smt = emptySmtPath(smtKey);
  const nullifierHash = await hash([inNullifier]);

  // Change note commitment: 0 when zero-change, else the carved change note (§6.1.6).
  const outCommitment =
    secondaryValue === 0n
      ? 0n
      : await commitment(secondaryValue, inLabel, inAssetId, outNullifier, outSecret);

  const publicInputs = [
    "0",
    "1",
    state.root.toString(),
    asp.root.toString(),
    smt.root,
    primaryValue.toString(),
    secondaryValue.toString(),
    outCommitment.toString(),
    "0",
    nullifierHash.toString(),
    "0",
    "0",
    "0",
    "0",
    "0",
    payeeId.toString(),
    "4",
    inAssetId.toString(),
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
  ];

  return {
    publicInputs,
    boundaryIndex: "0",
    inValue: [inValue.toString()],
    inNullifier: [inNullifier.toString()],
    inSecret: [inSecret.toString()],
    inLabel: [inLabel.toString()],
    inAssetId: [inAssetId.toString()],
    statePathElements: [state.pathElements.map(String)],
    statePathIndices: [state.pathIndices],
    admittedLeafIndex: ["0"],
    admittedPathElements: [asp.pathElements.map(String)],
    admittedPathIndices: [asp.pathIndices],
    revokedSmtPathElements: [smt.pathElements],
    revokedSmtPathIndices: [smt.pathIndices],
    revokedSmtLeaf: ["0"],
    outNullifier: outNullifier.toString(),
    outSecret: outSecret.toString(),
    rawPayee,
  };
}

const describeArtifacts = ARTIFACTS_PRESENT ? describe : describe.skip;

describeArtifacts("PROTOCOL withdraw1 (25-limb) invariants", () => {
  jest.setTimeout(180_000);

  test("valid ASP+SMT proof verifies with 25 public limbs", async () => {
    const input = await validWithdraw1Input();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    const vkey = JSON.parse(fs.readFileSync(VKEY, "utf8"));

    await expect(snarkjs.groth16.verify(vkey, publicSignals, proof)).resolves.toBe(true);
    expect(Number(vkey.nPublic)).toBe(25);
    expect(publicSignals).toEqual(input.publicInputs);
  });

  test("fractional change (0 < secondary < boundary) verifies (§6.1 v4)", async () => {
    // Withdraw 6,000,000 of a 10,000,000 note → 4,000,000 change note carved from the boundary.
    const input = await validWithdraw1Input({ primaryValue: 6_000_000n });
    expect(input.publicInputs[5]).toBe("6000000"); // primary
    expect(input.publicInputs[6]).toBe("4000000"); // secondary (change) — not 0, not full note
    expect(input.publicInputs[7]).not.toBe("0"); // change note commitment present

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    const vkey = JSON.parse(fs.readFileSync(VKEY, "utf8"));
    await expect(snarkjs.groth16.verify(vkey, publicSignals, proof)).resolves.toBe(true);
    expect(publicSignals).toEqual(input.publicInputs);
  });

  test("change exceeding boundary value cannot produce a proof (LessEqThan gate)", async () => {
    // primary=1 leaves secondary=9,999,999 which is ≤ inValue, so instead force an
    // over-boundary change directly: claim secondary > sum while keeping conservation broken
    // is caught by sum; the boundary rule is exercised by an inflated secondary vs a smaller
    // boundary. For N=1 the boundary IS the whole note, so drive the violation by claiming a
    // secondary larger than inValue (must fail: change > boundaryValue AND sum mismatch).
    const input = await validWithdraw1Input({ primaryValue: 6_000_000n });
    input.publicInputs[6] = (10_000_000n + 1n).toString(); // secondary > inValue (boundary)

    await expect(snarkjs.groth16.fullProve(input, WASM, ZKEY)).rejects.toThrow();
  });

  test("proof cannot be replayed against a different revokedRoot", async () => {
    const input = await validWithdraw1Input();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    const vkey = JSON.parse(fs.readFileSync(VKEY, "utf8"));
    const tampered = [...publicSignals];
    tampered[4] = (BigInt(tampered[4]) + 1n).toString();

    await expect(snarkjs.groth16.verify(vkey, tampered, proof)).resolves.toBe(false);
  });

  test("malformed ASP path cannot produce a proof", async () => {
    const input = await validWithdraw1Input();
    input.admittedPathElements[0][0] = (
      BigInt(input.admittedPathElements[0][0]) + 1n
    ).toString();

    await expect(snarkjs.groth16.fullProve(input, WASM, ZKEY)).rejects.toThrow();
  });

  test("output note cannot reuse the spent input nullifier", async () => {
    const input = await validWithdraw1Input();
    input.outNullifier = input.inNullifier[0];

    await expect(snarkjs.groth16.fullProve(input, WASM, ZKEY)).rejects.toThrow();
  });

  test("wrong rawPayee fails payeeId bind at public[15]", async () => {
    const input = await validWithdraw1Input();
    input.rawPayee = input.rawPayee.map((b) => (b + 1) % 256);

    await expect(snarkjs.groth16.fullProve(input, WASM, ZKEY)).rejects.toThrow();
  });
});

/**
 * Place attacker's leafHash at victim's 32-MSB SMT path (OMEGA F-5 freeze PoC).
 * Post-fix: non-inclusion still proves because claimedLeaf ≠ leafHash(victim).
 */
async function foreignOccupantSmt(victimLabel, attackerLabel) {
  const victimKey = await hash([1n, victimLabel]);
  const attackerLeaf = await hash([2n, attackerLabel]);
  const victimLeaf = await hash([2n, victimLabel]);
  const bits = smtPathIndicesFromKey(victimKey);
  const pathElements = [];
  let root = attackerLeaf;
  for (let i = 0; i < 32; i++) {
    const sibling = BigInt(EMPTY_SMT.EMPTY_SUBTREE[String(i)]);
    pathElements.push(sibling.toString());
    root = bits[i] === 0 ? await hash([root, sibling]) : await hash([sibling, root]);
  }
  return {
    root: root.toString(),
    pathElements,
    pathIndices: bits,
    claimedLeaf: attackerLeaf.toString(),
    victimLeaf: victimLeaf.toString(),
  };
}

describeArtifacts("DELTA F-5 SMT prefix-collision non-inclusion", () => {
  jest.setTimeout(180_000);

  test("foreign occupant at 32-bit slot still proves (freeze PoC blocked)", async () => {
    const input = await validWithdraw1Input();
    const victim = BigInt(input.inLabel[0]);
    const smt = await foreignOccupantSmt(victim, 99999n);
    input.revokedSmtPathElements = [smt.pathElements];
    input.revokedSmtPathIndices = [smt.pathIndices];
    input.revokedSmtLeaf = [smt.claimedLeaf];
    input.publicInputs[4] = smt.root;

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    const vkey = JSON.parse(fs.readFileSync(VKEY, "utf8"));
    await expect(snarkjs.groth16.verify(vkey, publicSignals, proof)).resolves.toBe(true);
  });

  test("self leafHash at slot fails non-inclusion (true revoke)", async () => {
    const input = await validWithdraw1Input();
    const victim = BigInt(input.inLabel[0]);
    const smt = await foreignOccupantSmt(victim, 99999n);
    // Rebuild path with victim's own leafHash as claimed leaf (revoked).
    const bits = smt.pathIndices;
    const pathElements = [];
    let root = BigInt(smt.victimLeaf);
    for (let i = 0; i < 32; i++) {
      const sibling = BigInt(EMPTY_SMT.EMPTY_SUBTREE[String(i)]);
      pathElements.push(sibling.toString());
      root = bits[i] === 0 ? await hash([root, sibling]) : await hash([sibling, root]);
    }
    input.revokedSmtPathElements = [pathElements];
    input.revokedSmtPathIndices = [bits];
    input.revokedSmtLeaf = [smt.victimLeaf];
    input.publicInputs[4] = root.toString();

    await expect(snarkjs.groth16.fullProve(input, WASM, ZKEY)).rejects.toThrow();
  });
});

describeArtifacts("DELTA F-7 ASP path bit-order (LSB-first)", () => {
  jest.setTimeout(180_000);

  // OMEGA PoC: PROTOCOL once said MSB-first; Circom Num2Bits is LSB at level 0.
  test("MSB-first pathIndices for leafIndex=1 are rejected", async () => {
    const input = await validWithdraw1Input();
    input.admittedLeafIndex = ["1"];
    const msbFirst = Array(32).fill(0);
    msbFirst[31] = 1;
    input.admittedPathIndices = [msbFirst];

    await expect(snarkjs.groth16.fullProve(input, WASM, ZKEY)).rejects.toThrow();
  });
});
