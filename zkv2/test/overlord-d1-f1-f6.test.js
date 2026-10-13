/**
 * OVERLORD DELTA — D1 findings F-1..F-6 PoC blockers (siphon-zk-v2).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  proveSpend,
  consentHostedProve,
  deriveExpectedPublics,
} = require("../sdk");
const { witnessToCircomInput } = require("../scripts/lib/witness-to-input.cjs");

const ROOT = path.join(__dirname, "..");
const SWAP_OK = path.join(ROOT, "test-vectors/swap-ok.json");
const WITHDRAW_W3 = path.join(ROOT, "test-vectors/withdraw-w3-ok.json");
const PROTOCOL = path.join(ROOT, "docs/PROTOCOL.md");
const SWAP_CIRCOM = path.join(ROOT, "circuits/spend/swap.circom");
const PRIVATE_SPEND = path.join(ROOT, "circuits/lib/private_spend.circom");
const RAGEQUIT_CIRCOM = path.join(ROOT, "circuits/spend/ragequit.circom");

function vaultRootsFrom(w) {
  return {
    stateRoot: w.stateRoot,
    admittedRoot: w.admittedRoot,
    revokedRoot: w.revokedRoot,
  };
}

describe("OVERLORD D1 F-1 SWAP public[15] bound", () => {
  test("circuit forces publicInputs[15] === 0", () => {
    const src = fs.readFileSync(SWAP_CIRCOM, "utf8");
    expect(src).toMatch(/publicInputs\[15\]\s*===\s*0/);
  });

  test("spend-core rejects non-zero SWAP rawPayee (PoC)", () => {
    const w = JSON.parse(fs.readFileSync(SWAP_OK, "utf8"));
    w.rawPayeeHex = "0000000000000000000000000000000000000001";
    const tmp = path.join(ROOT, "test-vectors/.tmp-swap-payee-poc.json");
    fs.writeFileSync(tmp, JSON.stringify(w));
    const r = spawnSync(
      "cargo",
      ["run", "-q", "-p", "siphon-prove", "--", "--witness", tmp],
      { cwd: ROOT, encoding: "utf8" },
    );
    fs.unlinkSync(tmp);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/payeeId must be zero|SwapPayeeMustBeZero/i);
  });
});

describe("OVERLORD D1 F-2 Circom assetId ≠ 0", () => {
  test("PrivateSpendInputs and ragequit constrain assetId non-zero", () => {
    const priv = fs.readFileSync(PRIVATE_SPEND, "utf8");
    const rq = fs.readFileSync(RAGEQUIT_CIRCOM, "utf8");
    expect(priv).toMatch(/assetZero/);
    expect(priv).toMatch(/enabled\[i\] \* assetZero\[i\]\.out === 0/);
    expect(rq).toMatch(/assetNonZero/);
    expect(rq).toMatch(/assetNonZero\.out === 0/);
  });
});

describe("OVERLORD D1 F-3 F-8 binds inAssetId", () => {
  test("proveSpend rejects Circom input with drifted inAssetId", async () => {
    const witnessJson = fs.readFileSync(WITHDRAW_W3, "utf8");
    const witness = JSON.parse(witnessJson);
    const limbs = deriveExpectedPublics(witnessJson);
    const circom = witnessToCircomInput(witness);
    const bad = structuredClone(circom);
    bad.inAssetId = bad.inAssetId.map((x, i) =>
      i === 0 ? String(BigInt(x) + 1n) : x,
    );
    await expect(
      proveSpend({
        action: 0,
        inputCount: 3,
        input: bad,
        witnessJson,
        expectedPublics: limbs,
        vaultRoots: vaultRootsFrom(witness),
        prefer: "hosted",
        consent: consentHostedProve({
          witness,
          action: 0,
          inputCount: 3,
        }),
      }),
    ).rejects.toThrow(/inAssetId|F-8/);
  });
});

describe("OVERLORD D1 F-4 fail-closed missing inAssetId", () => {
  test("witnessToCircomInput throws when inAssetId omitted", () => {
    const w = JSON.parse(fs.readFileSync(SWAP_OK, "utf8"));
    delete w.inputs[0].inAssetId;
    expect(() => witnessToCircomInput(w)).toThrow(/inAssetId required/);
  });
});

describe("OVERLORD D1 F-5 / F-6 PROTOCOL deltas", () => {
  const proto = fs.readFileSync(PROTOCOL, "utf8");

  test("F-5 §4.4 commitment includes assetId", () => {
    expect(proto).toMatch(
      /outCommitment\[i\] = commitment\(outValue\[i\], outLabel, assetId, outNullifier\[i\], outSecret\[i\]\)/,
    );
  });

  test("F-6 deposit Circom deferred; vault bind normative", () => {
    expect(proto).toMatch(/Circom deposit circuit is \*\*deferred\*\*/);
    expect(proto).toMatch(/VaultKernel\.deposit/);
  });
});
