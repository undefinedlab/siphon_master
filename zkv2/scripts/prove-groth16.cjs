#!/usr/bin/env node
"use strict";

/**
 * Prove a PROTOCOL Groth16 spend (snarkjs or rapidsnark).
 *
 *   node scripts/prove-groth16.cjs --circuit withdraw1 --input witness.json
 *   node scripts/prove-groth16.cjs --circuit withdraw1 --input witness.json --backend rapidsnark
 */
const fs = require("fs");
const path = require("path");
const { BY_KEY } = require("./lib/circuits.cjs");
const { artifactPaths, proveGroth16, verifyProof } = require("./lib/groth16-prove.cjs");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const ROOT = path.resolve(__dirname, "..");
const circuitKey = arg("--circuit");
const inputPath = arg("--input");
const backend = arg("--backend") || "snarkjs";
const outPath = arg("--out");
const artifactsDir = arg("--artifacts") || path.join(ROOT, "artifacts");

if (!circuitKey || !inputPath) {
  console.error(
    "usage: prove-groth16.cjs --circuit withdraw1 --input witness.json [--backend snarkjs|rapidsnark] [--out proof.json]",
  );
  process.exit(1);
}

if (!BY_KEY[circuitKey]) {
  console.error(`unknown circuit ${circuitKey}`);
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
const { wasm, zkey, vkey } = artifactPaths(artifactsDir, circuitKey);

(async () => {
  const result = await proveGroth16({ input, wasm, zkey, backend });
  const verified = await verifyProof(vkey, result.publicSignals, result.proof);

  const payload = {
    circuit: circuitKey,
    backend: result.backend,
    witness_ms: result.witness_ms,
    prove_ms: result.prove_ms,
    verified,
    proof: result.proof,
    publicSignals: result.publicSignals,
  };

  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 2));
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }

  try {
    fs.rmSync(result.workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  process.exit(verified ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
