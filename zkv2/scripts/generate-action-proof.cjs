#!/usr/bin/env node
"use strict";

/**
 * Generate real action Groth16 proof for Foundry fixtures.
 *
 *   node scripts/generate-action-proof.cjs ragequit-revoked-witness-ok.json
 */
const fs = require("fs");
const path = require("path");
const { circuitKeyForAction } = require("./lib/circuits.cjs");
const { artifactPaths, proveGroth16, verifyProof } = require("./lib/groth16-prove.cjs");
const { witnessToCircomInput } = require("./lib/witness-to-input.cjs");
const { deriveExpectedPublics } = require("./lib/spend-core-publics.cjs");

const ROOT = path.resolve(__dirname, "..");
const TV = path.join(ROOT, "test-vectors");
const fixtureName = process.argv[2];

if (!fixtureName) {
  console.error("usage: node scripts/generate-action-proof.cjs <witness-fixture.json>");
  process.exit(1);
}

const fixturePath = path.join(TV, fixtureName);
const witness = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
if (!witness.expectedPublic || witness.expectedPublic.length !== 25) {
  throw new Error(`${fixtureName}: missing 25-limb expectedPublic`);
}

// F-9: never trust fixture expectedPublic for Circom publics — re-derive via spend-core.
const derived = deriveExpectedPublics(witness);
for (let i = 0; i < 25; i++) {
  if (BigInt(derived[i]) !== BigInt(witness.expectedPublic[i])) {
    throw new Error(
      `${fixtureName}: expectedPublic[${i}] drift vs spend-core (got ${witness.expectedPublic[i]} want ${derived[i]})`,
    );
  }
}
witness.expectedPublic = derived;

const circuitKey = circuitKeyForAction(Number(witness.action), Number(witness.inputCount));
const input = witnessToCircomInput(witness);
input.publicInputs = derived;
const { wasm, zkey, vkey } = artifactPaths(path.join(ROOT, "artifacts"), circuitKey);

(async () => {
  const result = await proveGroth16({ input, wasm, zkey, backend: "snarkjs" });
  const verified = await verifyProof(vkey, result.publicSignals, result.proof);
  if (!verified) throw new Error("local verify failed");

  const flatProof = [
    result.proof.pi_a[0],
    result.proof.pi_a[1],
    result.proof.pi_b[0][1],
    result.proof.pi_b[0][0],
    result.proof.pi_b[1][1],
    result.proof.pi_b[1][0],
    result.proof.pi_c[0],
    result.proof.pi_c[1],
  ];

  const outName = fixtureName.replace(/\.json$/, "-action-proof.json");
  fs.writeFileSync(
    path.join(TV, outName),
    JSON.stringify(
      {
        fixture: fixtureName,
        circuit: circuitKey,
        expectedPublic: derived,
        proof: flatProof,
        _comment: "Real action Groth16 proof — regenerate after circuit/zkey change",
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Wrote", outName);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
