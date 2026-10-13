"use strict";

const fs = require("fs");
const path = require("path");

const {
  consentHostedProve,
  deriveExpectedPublics,
  assertPublicsMatch,
  assertRootsCurrent,
  proveSpend,
  proveScopeDigest,
  HOSTED_DISCLOSED_FIELDS,
  PUBLIC_WIDTH,
} = require("../sdk");
const { witnessToCircomInput } = require("../scripts/lib/witness-to-input.cjs");
const { artifactsAvailable } = require("./helpers/realProve");

const WITHDRAW_W3 = path.join(__dirname, "../test-vectors/withdraw-w3-ok.json");

function vaultRootsFrom(w) {
  return {
    stateRoot: w.stateRoot,
    admittedRoot: w.admittedRoot,
    revokedRoot: w.revokedRoot,
  };
}

describe("M6 zkv2-sdk consent + publics (GF-H1 / GF-M1)", () => {
  const witnessJson = fs.readFileSync(WITHDRAW_W3, "utf8");
  const witness = JSON.parse(witnessJson);
  const limbs = deriveExpectedPublics(witnessJson);
  const input = witness;
  const circomInput = witnessToCircomInput(witness);

  test("consentHostedProve requires witness + action/inputCount + full freeze-list", () => {
    expect(() => consentHostedProve({})).toThrow(/witness object|action and inputCount/);
    expect(() =>
      consentHostedProve({
        witness: input,
        action: 0,
        inputCount: 3,
        disclosedFields: ["nullifiers"],
      }),
    ).toThrow(/secrets/);
    const c = consentHostedProve({ witness: input, action: 0, inputCount: 3 });
    expect(c.consentId).toMatch(/^[a-f0-9]{32}$/);
    expect(c.disclosedFields).toEqual([...HOSTED_DISCLOSED_FIELDS]);
    expect(c.witnessDigest).toBe(proveScopeDigest(input, 0, 3));
  });

  test("proveSpend requires vaultRoots (F-5)", async () => {
    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input: witness,
        witnessJson,
        prefer: "hosted",
        expectedPublics: limbs,
      }),
    ).rejects.toThrow(/vaultRoots required/);
  });

  test("proveSpend requires expectedPublics and witnessJson", async () => {
    await expect(
      proveSpend({
        action: 0,
        inputCount: 1,
        input: {},
        prefer: "local",
      }),
    ).rejects.toThrow(/expectedPublics required/);

    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input,
        expectedPublics: limbs,
        prefer: "hosted",
      }),
    ).rejects.toThrow(/witnessJson required/);
  });

  test("proveSpend hosted without consent throws", async () => {
    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input: witness,
        witnessJson,
        prefer: "hosted",
        vaultRoots: vaultRootsFrom(witness),
        expectedPublics: limbs,
      }),
    ).rejects.toThrow(/consentHostedProve/);
  });

  test("proveSpend hosted rejects sticker consent / digest drift", async () => {
    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input: witness,
        witnessJson,
        prefer: "hosted",
        vaultRoots: vaultRootsFrom(witness),
        expectedPublics: limbs,
        consent: {
          consentId: "00".repeat(16),
          disclosedFields: [...HOSTED_DISCLOSED_FIELDS],
          witnessDigest: "deadbeef",
        },
      }),
    ).rejects.toThrow(/witnessDigest mismatch/);
  });

  test("proveSpend local runs real Groth16 when artifacts present", async () => {
    if (!artifactsAvailable(0, 3)) {
      console.warn("skip: withdraw3 artifacts missing — run npm run build");
      return;
    }
    const out = await proveSpend({
      action: 0,
      inputCount: 3,
      input: circomInput,
      witnessJson,
      prefer: "local",
      vaultRoots: vaultRootsFrom(witness),
        expectedPublics: limbs,
    });
    expect(out.mode).toBe("local");
    expect(out.publicSignals.length).toBe(PUBLIC_WIDTH);
    assertPublicsMatch(limbs, out.publicSignals);
  });

  test("assertPublicsMatch accepts equal 25 limbs", () => {
    expect(assertPublicsMatch(limbs, limbs.map(BigInt))).toBe(true);
  });

  test("assertPublicsMatch rejects drift", () => {
    const a = Array.from({ length: PUBLIC_WIDTH }, () => "0");
    const b = [...a];
    b[5] = "1";
    expect(() => assertPublicsMatch(a, b)).toThrow(/limb\[5\]/);
  });

  test("assertRootsCurrent detects TOCTOU", () => {
    expect(() =>
      assertRootsCurrent(
        { stateRoot: 1, admittedRoot: 2, revokedRoot: 3 },
        { stateRoot: 1, admittedRoot: 9, revokedRoot: 3 },
      ),
    ).toThrow(/admittedRoot/);
  });
});

describe("DELTA F-3 PoC blockers (GF-H1 hosted consent / publics)", () => {
  const witnessJson = fs.readFileSync(WITHDRAW_W3, "utf8");
  const witness = JSON.parse(witnessJson);
  const limbs = deriveExpectedPublics(witnessJson);
  const input = witness;
  const circomInput = witnessToCircomInput(witness);

  test("rejects sticker consentId-only hosted prove", async () => {
    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input: witness,
        witnessJson,
        prefer: "hosted",
        vaultRoots: vaultRootsFrom(witness),
        expectedPublics: limbs,
        consent: { consentId: "00".repeat(16) },
      }),
    ).rejects.toThrow(/disclosedFields|witnessDigest|freeze-list|secrets/);
  });

  test("rejects incomplete freeze-list at proveSpend boundary", async () => {
    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input: witness,
        witnessJson,
        prefer: "hosted",
        vaultRoots: vaultRootsFrom(witness),
        expectedPublics: limbs,
        consent: {
          consentId: "11".repeat(16),
          disclosedFields: ["nullifiers", "amounts"],
          witnessDigest: proveScopeDigest(input, 0, 3),
        },
      }),
    ).rejects.toThrow(/secrets|freeze-list/);
  });

  test("rejects hosted publicSignals that drift from expectedPublics", async () => {
    const consent = consentHostedProve({ witness: input, action: 0, inputCount: 3 });
    const swapped = [...limbs];
    swapped[5] = "999999";
    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input: witness,
        witnessJson,
        prefer: "hosted",
        vaultRoots: vaultRootsFrom(witness),
        expectedPublics: limbs,
        consent,
        hostedProve: async () => ({ proof: { pi_a: ["1"] }, publicSignals: swapped }),
      }),
    ).rejects.toThrow(/limb\[5\]/);
  });

  test("rejects wrong-length expectedPublics before any prove", async () => {
    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input: witness,
        witnessJson,
        prefer: "hosted",
        vaultRoots: vaultRootsFrom(witness),
        expectedPublics: ["0", "1"],
        consent: consentHostedProve({ witness: input, action: 0, inputCount: 3 }),
      }),
    ).rejects.toThrow(/25 limbs/);
  });
});
