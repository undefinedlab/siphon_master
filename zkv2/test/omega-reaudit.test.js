"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  consentHostedProve,
  deriveExpectedPublics,
  proveScopeDigest,
  proveSpend,
  witnessDigest,
  HOSTED_DISCLOSED_FIELDS,
  PUBLIC_WIDTH,
  assertRootsCurrent,
} = require("../sdk");

const ROOT = path.resolve(__dirname, "..");
const WITHDRAW_W3 = path.join(ROOT, "test-vectors/withdraw-w3-ok.json");
const CHECK_PINS = path.join(ROOT, "scripts/check-pins.cjs");

function vaultRootsFrom(w) {
  return {
    stateRoot: w.stateRoot,
    admittedRoot: w.admittedRoot,
    revokedRoot: w.revokedRoot,
  };
}

describe("DELTA OMEGA re-audit Z-1 (expectedPublics spend-core bind)", () => {
  const witnessJson = fs.readFileSync(WITHDRAW_W3, "utf8");
  const witness = JSON.parse(witnessJson);
  const derived = deriveExpectedPublics(witnessJson);

  test("OMEGA Z-1 PoC: attacker-chosen expectedPublics rejected vs spend-core", async () => {
    const attacker = [...derived];
    attacker[5] = "9999999999999999999999999999999999999999999999999999999999999999";
    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input: witness,
        witnessJson,
        vaultRoots: vaultRootsFrom(witness),
        expectedPublics: attacker,
        prefer: "hosted",
        consent: consentHostedProve({
          witness,
          action: 0,
          inputCount: 3,
        }),
      }),
    ).rejects.toThrow(/limb\[5\]/);
  });

  test("proveSpend requires witnessJson (no self-tautology path)", async () => {
    await expect(
      proveSpend({
        action: 0,
        inputCount: 1,
        input: {},
        expectedPublics: derived,
        prefer: "hosted",
      }),
    ).rejects.toThrow(/witnessJson required/);
  });

  test("deriveExpectedPublics matches withdraw-w3 fixture guest commit", () => {
    expect(derived.length).toBe(PUBLIC_WIDTH);
    expect(derived[0]).toBe("0");
    expect(derived[1]).toBe("3");
    expect(derived[5]).toBe("750");
  });
});

describe("DELTA OMEGA re-audit Z-2 (assertRootsCurrent wired in proveSpend)", () => {
  const witnessJson = fs.readFileSync(WITHDRAW_W3, "utf8");
  const witness = JSON.parse(witnessJson);
  const derived = deriveExpectedPublics(witnessJson);

  test("OMEGA Z-2 PoC: stale admittedRoot rejected before hosted prove", async () => {
    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input: witness,
        witnessJson,
        expectedPublics: derived,
        vaultRoots: {
          stateRoot: witness.stateRoot,
          admittedRoot: String(BigInt(witness.admittedRoot) + 1n),
          revokedRoot: witness.revokedRoot,
        },
        prefer: "hosted",
        consent: consentHostedProve({ witness, action: 0, inputCount: 3 }),
      }),
    ).rejects.toThrow(/admittedRoot/);
  });
});

describe("DELTA OMEGA re-audit Z-3 (consent digest scope bind)", () => {
  const witness = { amount: "1000", label: "abc" };

  test("OMEGA Z-3 PoC: consent without action/inputCount rejected", () => {
    expect(() => consentHostedProve({ witness })).toThrow(/action and inputCount/);
  });

  test("digest changes when circuit scope changes", () => {
    const d1 = proveScopeDigest(witness, 0, 1);
    const d2 = proveScopeDigest(witness, 1, 2);
    expect(d1).not.toBe(d2);
  });

  test("legacy witnessDigest without scope differs from scoped digest", () => {
    const bare = witnessDigest(witness);
    const scoped = proveScopeDigest(witness, 0, 1);
    expect(bare).not.toBe(scoped);
  });
});

describe("DELTA OMEGA re-audit Z-5 (VK pin fail-closed)", () => {
  test("OMEGA Z-5 PoC: missing actionVkHashes entry exits non-zero", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delta-z5-"));
    const manifestPath = path.join(dir, "manifest.json");
    const art = path.join(dir, "artifacts");
    fs.mkdirSync(art);

    const partial = {
      actionZkeyHashes: { withdraw1: "sha256:abc" },
      actionVkHashes: {},
    };
    fs.writeFileSync(manifestPath, JSON.stringify(partial));

    const r = spawnSync(process.execPath, [CHECK_PINS], {
      env: {
        ...process.env,
        SIPHON_MANIFEST_PATH: manifestPath,
        SIPHON_ARTIFACTS_DIR: art,
        CI: "",
      },
      encoding: "utf8",
    });

    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/actionVkHashes.*withdraw1|withdraw1.*missing/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("DELTA OMEGA re-audit Z-7 (PROTOCOL ASP bit-order doc)", () => {
  test("§5.1.9 documents LSB-first ASP path bind (not MSB-first)", () => {
    const proto = fs.readFileSync(path.join(ROOT, "docs/PROTOCOL.md"), "utf8");
    const section = proto.split("### 5.1")[1]?.split("### 5.2")[0] ?? "";
    expect(section).toMatch(/LSB-first/);
    expect(section).not.toMatch(/same MSB-first convention as SMT keys, applied to admitted leaf index/);
  });

  test("assertRootsCurrent still detects drift (GF-M1 helper)", () => {
    expect(() =>
      assertRootsCurrent(
        { stateRoot: 1, admittedRoot: 2, revokedRoot: 3 },
        { stateRoot: 1, admittedRoot: 9, revokedRoot: 3 },
      ),
    ).toThrow(/admittedRoot/);
  });
});
