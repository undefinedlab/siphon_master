/**
 * OVERLORD DELTA — F-7..F-10 PoC blockers (siphon-zk-v2 re-audit).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const {
  HOSTED_DISCLOSED_FIELDS,
  consentHostedProve,
} = require("../sdk");

const ROOT = path.resolve(__dirname, "..");
const PROTOCOL = path.join(ROOT, "docs/PROTOCOL.md");
const SWAP_CIRCOM = path.join(ROOT, "circuits/spend/swap.circom");
const SPLIT_VALIDATE = path.join(ROOT, "spend-core/src/validate/split.rs");

describe("OVERLORD F-7 HOSTED_DISCLOSED_FIELDS includes D1 assets", () => {
  test("assetIds and inAssetId are disclosed on hosted prove", () => {
    expect(HOSTED_DISCLOSED_FIELDS).toContain("assetIds");
    expect(HOSTED_DISCLOSED_FIELDS).toContain("inAssetId");
  });

  test("consent receipt freezes the disclosed list including assets", () => {
    const c = consentHostedProve({
      witness: { amount: "1", inAssetId: "4096" },
      action: 2,
      inputCount: 1,
    });
    expect(c.disclosedFields).toEqual([...HOSTED_DISCLOSED_FIELDS]);
    expect(c.disclosedFields).toContain("assetIds");
    expect(c.disclosedFields).toContain("inAssetId");
  });
});

describe("OVERLORD F-8 PROTOCOL SWAP payeeId wording", () => {
  test("§8.1 table binds SWAP payeeId to zero, not WITHDRAW payout", () => {
    const md = fs.readFileSync(PROTOCOL, "utf8");
    const section = md.slice(md.indexOf("### 8.1"), md.indexOf("### 8.2"));
    expect(section).not.toMatch(/WITHDRAW\s*\/\s*SWAP/);
    expect(section).toMatch(/SWAP[\s\S]{0,160}publicInputs\[15\]\s*==\s*0/);
  });

  test("§16 does not say withdraw/swap share payee bind", () => {
    const md = fs.readFileSync(PROTOCOL, "utf8");
    expect(md).not.toMatch(/Withdraw\/swap:\s*calldata carries/);
    expect(md).toMatch(/SWAP \(D1 pool\):\s*`publicInputs\[15\] == 0`/);
  });
});

describe("OVERLORD F-9 SPLIT nullifier ≠ input nullifier in spend-core", () => {
  test("split.rs rejects slice nullifier equal to input", () => {
    const src = fs.readFileSync(SPLIT_VALIDATE, "utf8");
    expect(src).toMatch(/SplitNullifierReusesInput/);
    expect(src).toMatch(/nullifiers\[i\] == validated\.nullifiers\[0\]/);
  });
});

describe("OVERLORD F-10 SWAP fee Num2Bits(24)", () => {
  test("swap.circom range-checks fee to 24 bits", () => {
    const src = fs.readFileSync(SWAP_CIRCOM, "utf8");
    expect(src).toMatch(/component feeBits = Num2Bits\(24\);/);
    expect(src).toMatch(/feeBits\.in <== fee;/);
  });
});
