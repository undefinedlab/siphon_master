/**
 * OVERLORD DELTA — F-1..F-9 PoC blockers (siphon-zkv2 SDK / circuits).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const {
  circuitKeyForAction,
  consentHostedProve,
  proveScopeDigest,
  witnessDigest,
  canonicalize,
  proveSpend,
  deriveExpectedPublics,
} = require("../sdk");
const { artifactsAvailable } = require("./helpers/realProve");

const WITHDRAW_W3 = path.join(__dirname, "../test-vectors/withdraw-w3-ok.json");

function vaultRootsFrom(w) {
  return {
    stateRoot: w.stateRoot,
    admittedRoot: w.admittedRoot,
    revokedRoot: w.revokedRoot,
  };
}

describe("OVERLORD F-1 circuitKey whitelist", () => {
  test("rejects path-injection inputCount", () => {
    expect(() => circuitKeyForAction(0, "3/../../tmp/evil")).toThrow(/invalid inputCount/);
    expect(() => circuitKeyForAction(0, "3")).toThrow(/invalid inputCount/);
    expect(() => circuitKeyForAction(0, 99)).toThrow(/invalid inputCount/);
    expect(circuitKeyForAction(0, 3)).toBe("withdraw3");
  });
});

describe("OVERLORD F-6 consent digest canonicalization", () => {
  test("nested key order does not change digest", () => {
    const a = { outer: { b: 1, a: 2 }, z: 9 };
    const b = { z: 9, outer: { a: 2, b: 1 } };
    expect(JSON.stringify(canonicalize(a))).toBe(JSON.stringify(canonicalize(b)));
    expect(witnessDigest(a)).toBe(witnessDigest(b));
  });

  test("ignores caller-supplied witnessDigest at mint", () => {
    const witness = { amount: "1" };
    const c = consentHostedProve({
      witness,
      action: 0,
      inputCount: 1,
      witnessDigest: "deadbeef",
    });
    expect(c.witnessDigest).toBe(proveScopeDigest(witness, 0, 1));
    expect(c.witnessDigest).not.toBe("deadbeef");
  });
});

describe("OVERLORD F-2 / F-5 / F-8 proveSpend gates", () => {
  const witnessJson = fs.readFileSync(WITHDRAW_W3, "utf8");
  const witness = JSON.parse(witnessJson);
  const limbs = deriveExpectedPublics(witnessJson);

  test("F-8 rejects mismatched input nullifier vs witnessJson", async () => {
    const bad = structuredClone(witness);
    bad.inputs[0].inNullifier = String(BigInt(bad.inputs[0].inNullifier) + 1n);
    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input: bad,
        witnessJson,
        expectedPublics: limbs,
        vaultRoots: vaultRootsFrom(witness),
        prefer: "hosted",
        consent: consentHostedProve({ witness: bad, action: 0, inputCount: 3 }),
      }),
    ).rejects.toThrow(/mismatch|F-8/);
  });

  test("F-2 rejects hosted garbage proof when vkey present", async () => {
    if (!artifactsAvailable(0, 3)) {
      console.warn("skip F-2: withdraw3 artifacts missing");
      return;
    }
    const consent = consentHostedProve({ witness, action: 0, inputCount: 3 });
    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input: witness,
        witnessJson,
        expectedPublics: limbs,
        vaultRoots: vaultRootsFrom(witness),
        prefer: "hosted",
        consent,
        hostedProve: async () => ({
          proof: {
            pi_a: ["1", "2", "1"],
            pi_b: [
              ["1", "2"],
              ["1", "2"],
              ["1", "1"],
            ],
            pi_c: ["1", "2", "1"],
            protocol: "groth16",
            curve: "bn128",
          },
          publicSignals: limbs,
        }),
      }),
    ).rejects.toThrow(/verify failed|F-2/);
  });
});
