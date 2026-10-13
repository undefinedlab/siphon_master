#!/usr/bin/env node
"use strict";

/**
 * Bench snarkjs vs rapidsnark Groth16 prove for PROTOCOL circuits.
 *
 *   node scripts/bench-prove.cjs withdraw1
 *   node scripts/bench-prove.cjs withdraw1 --backend snarkjs
 *   RAPIDSNARK_PROVER=/path/to/prover node scripts/bench-prove.cjs withdraw1 --backend rapidsnark
 */
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const { BY_KEY } = require("./lib/circuits.cjs");
const {
  artifactPaths,
  proveGroth16,
  verifyProof,
  defaultRapidsnarkProver,
} = require("./lib/groth16-prove.cjs");

const ROOT = path.resolve(__dirname, "..");
const ART = process.env.PROTOCOL_ARTIFACTS_DIR || path.join(ROOT, "artifacts");
const EMPTY_SMT = JSON.parse(
  fs.readFileSync(path.join(ROOT, "test-vectors/smt/empty-subtrees.json"), "utf8"),
);

const circuitKey = process.argv[2] || "withdraw1";
const backendArg = process.argv.includes("--backend")
  ? process.argv[process.argv.indexOf("--backend") + 1]
  : "auto";

if (!BY_KEY[circuitKey]) {
  console.error(`unknown circuit ${circuitKey}`);
  process.exit(1);
}

const { wasm, zkey, vkey } = artifactPaths(ART, circuitKey);
for (const p of [wasm, zkey, vkey]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${p} — run npm run build`);
    process.exit(1);
  }
}

let poseidon;
let F;
async function hash(inputs) {
  if (!poseidon) {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  }
  return BigInt(F.toObject(poseidon(inputs.map((x) => BigInt(x)))));
}

async function commitment(amount, label, nullifier, secret) {
  return hash([await hash([amount, label]), await hash([nullifier, secret])]);
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
  for (let j = 0; j < 32; j++) bits.push(Number((k >> (253n - BigInt(j))) & 1n));
  return bits;
}

function emptySmtPath(key) {
  const pathElements = [];
  for (let i = 0; i < 32; i++) pathElements.push(EMPTY_SMT.EMPTY_SUBTREE[String(i)]);
  return {
    pathElements,
    pathIndices: smtPathIndicesFromKey(key),
    root: EMPTY_SMT.EMPTY_REVOKED_ROOT,
  };
}

async function benchInputWithdraw1() {
  const inValue = 10_000_000n;
  const inLabel = 123456789n;
  const inNullifier = 111111n;
  const inSecret = 222222n;
  const payeeId = 99n;
  const leaf = await commitment(inValue, inLabel, inNullifier, inSecret);
  const state = await oneLeafWitness(leaf);
  const asp = await oneLeafWitness(inLabel);
  const smtKey = await hash([1n, inLabel]);
  const smt = emptySmtPath(smtKey);
  const nh = await hash([inNullifier]);
  return {
    publicInputs: [
      "0", "1", state.root.toString(), asp.root.toString(), smt.root,
      inValue.toString(), "0", "0", "0", nh.toString(),
      "0", "0", "0", "0", "0", payeeId.toString(), "2",
      "0", "0", "0", "0", "0", "0", "0", "0",
    ],
    boundaryIndex: "0",
    inValue: [inValue.toString()],
    inNullifier: [inNullifier.toString()],
    inSecret: [inSecret.toString()],
    inLabel: [inLabel.toString()],
    statePathElements: [state.pathElements.map(String)],
    statePathIndices: [state.pathIndices],
    admittedLeafIndex: ["0"],
    admittedPathElements: [asp.pathElements.map(String)],
    admittedPathIndices: [asp.pathIndices],
    revokedSmtPathElements: [smt.pathElements],
    revokedSmtPathIndices: [smt.pathIndices],
    outNullifier: "333333",
    outSecret: "444444",
  };
}

async function buildInput() {
  if (circuitKey === "withdraw1") return benchInputWithdraw1();
  throw new Error(`bench input not implemented for ${circuitKey} — add witness builder or pass --input file`);
}

async function benchSnarkjsFullProve(input) {
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  const prove_ms = Math.round(performance.now() - t0);
  const ok = await verifyProof(vkey, publicSignals, proof);
  return { system: "snarkjs-fullProve", prove_ms, witness_ms: null, verified: ok };
}

async function benchSplit(input, backend) {
  const r = await proveGroth16({ input, wasm, zkey, backend });
  const ok = await verifyProof(vkey, r.publicSignals, r.proof);
  try {
    fs.rmSync(r.workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return {
    system: backend === "rapidsnark" ? "rapidsnark" : "snarkjs-wtns+prove",
    witness_ms: r.witness_ms,
    prove_ms: r.prove_ms,
    total_ms: r.witness_ms + r.prove_ms,
    verified: ok,
  };
}

const input = process.argv.includes("--input")
  ? JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--input") + 1], "utf8"))
  : null;

async function main() {
  const witnessInput = input ?? (await buildInput());
  const rapidsnark = defaultRapidsnarkProver();
  const results = [];

  if (backendArg === "auto" || backendArg === "snarkjs") {
    results.push(await benchSnarkjsFullProve(witnessInput));
    results.push(await benchSplit(witnessInput, "snarkjs"));
  }

  if (backendArg === "auto" || backendArg === "rapidsnark") {
    if (rapidsnark && fs.existsSync(rapidsnark)) {
      results.push(await benchSplit(witnessInput, "rapidsnark"));
    } else if (backendArg === "rapidsnark") {
      console.error("RAPIDSNARK_PROVER not set");
      process.exit(1);
    }
  }

  console.log(
    JSON.stringify(
      {
        circuit: circuitKey,
        artifacts: ART,
        rapidsnark_prover: rapidsnark || null,
        zkey_mb: +(fs.statSync(zkey).size / 1e6).toFixed(1),
        results,
      },
      null,
      2,
    ),
  );

  process.exit(results.every((r) => r.verified) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
