"use strict";

/**
 * Groth16 prove helpers — snarkjs (default) or native rapidsnark prover.
 *
 * Rapidsnark: build iden3/rapidsnark, then set RAPIDSNARK_PROVER to the prover binary.
 * Witness is always computed with circom wasm + snarkjs.wtns.calculate (same as snarkjs).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const snarkjs = require("snarkjs");

function defaultRapidsnarkProver() {
  return (
    process.env.RAPIDSNARK_PROVER ||
    process.env.RAPIDSNARK ||
    (fs.existsSync("/usr/local/bin/prover") ? "/usr/local/bin/prover" : null)
  );
}

function artifactPaths(artifactsDir, circuitKey) {
  const dir = path.join(artifactsDir, circuitKey);
  const main = circuitKey; // withdraw1, merge2, …
  return {
    dir,
    wasm: path.join(dir, `${main}.wasm`),
    zkey: path.join(dir, "zkey_final.zkey"),
    vkey: path.join(dir, "verification_key.json"),
  };
}

async function calculateWitness(input, wasm, wtnsPath) {
  await snarkjs.wtns.calculate(input, wasm, wtnsPath, {});
}

async function proveWithSnarkjs(zkey, wtnsPath) {
  return snarkjs.groth16.prove(zkey, wtnsPath);
}

function proveWithRapidsnark(proverBin, zkey, wtnsPath, outDir) {
  const proofPath = path.join(outDir, "proof.json");
  const publicPath = path.join(outDir, "public.json");
  execFileSync(proverBin, [zkey, wtnsPath, proofPath, publicPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  const publicSignals = JSON.parse(fs.readFileSync(publicPath, "utf8"));
  return { proof, publicSignals };
}

/**
 * @param {object} opts
 * @param {object} opts.input witness JSON
 * @param {string} opts.wasm
 * @param {string} opts.zkey
 * @param {"snarkjs"|"rapidsnark"|"auto"} [opts.backend]
 * @param {string} [opts.rapidsnarkProver]
 * @param {string} [opts.workDir] temp dir (created if omitted)
 * @returns {Promise<{ proof, publicSignals, backend, witness_ms, prove_ms, workDir }>}
 */
async function proveGroth16(opts) {
  const backendPref = opts.backend || "snarkjs";
  const rapidsnark = opts.rapidsnarkProver || defaultRapidsnarkProver();
  const useRapidsnark =
    backendPref === "rapidsnark" ||
    (backendPref === "auto" && rapidsnark && fs.existsSync(rapidsnark));

  const ownWorkDir = !opts.workDir;
  const workDir =
    opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), "siphon-groth16-"));
  const wtnsPath = path.join(workDir, "witness.wtns");

  try {
    const tW0 = Date.now();
    await calculateWitness(opts.input, opts.wasm, wtnsPath);
    const witness_ms = Date.now() - tW0;

    const tP0 = Date.now();
    let result;
    let backend;
    if (useRapidsnark) {
      backend = "rapidsnark";
      result = proveWithRapidsnark(rapidsnark, opts.zkey, wtnsPath, workDir);
    } else {
      if (backendPref === "rapidsnark") {
        throw new Error(
          "rapidsnark backend requested but RAPIDSNARK_PROVER not set or missing",
        );
      }
      backend = "snarkjs";
      result = await proveWithSnarkjs(opts.zkey, wtnsPath);
    }
    const prove_ms = Date.now() - tP0;

    return {
      ...result,
      backend,
      witness_ms,
      prove_ms,
    };
  } finally {
    // F-4: never leave witness.wtns (nullifiers/secrets) on disk.
    if (ownWorkDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } else if (fs.existsSync(wtnsPath)) {
      try {
        fs.rmSync(wtnsPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

async function verifyProof(vkeyPath, publicSignals, proof) {
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

module.exports = {
  artifactPaths,
  calculateWitness,
  proveWithSnarkjs,
  proveWithRapidsnark,
  proveGroth16,
  verifyProof,
  defaultRapidsnarkProver,
};
