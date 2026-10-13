"use strict";

const fs = require("fs");
const path = require("path");
const { proveGroth16, artifactPaths } = require("../../scripts/lib/groth16-prove.cjs");
const { witnessToCircomInput } = require("../../scripts/lib/witness-to-input.cjs");

const ROOT = path.resolve(__dirname, "../..");

function resolveArtifacts(action, inputCount) {
  const { circuitKeyForAction } = require("../../scripts/lib/circuits.cjs");
  const key = circuitKeyForAction(action, inputCount);
  const paths = artifactPaths(
    process.env.PROTOCOL_ARTIFACTS_DIR || path.join(ROOT, "artifacts"),
    key,
  );
  if (![paths.wasm, paths.zkey].every((p) => fs.existsSync(p))) {
    return null;
  }
  return { key, paths };
}

/** Real Groth16 prove from PROTOCOL witness JSON (local snarkjs / rapidsnark). */
async function proveWitnessJson(witnessJson, action, inputCount) {
  const art = resolveArtifacts(action, inputCount);
  if (!art) {
    throw new Error(`missing artifacts for action=${action} inputCount=${inputCount}`);
  }
  const witness =
    typeof witnessJson === "string" ? JSON.parse(witnessJson) : witnessJson;
  const input = witnessToCircomInput(witness);
  const result = await proveGroth16({
    input,
    wasm: art.paths.wasm,
    zkey: art.paths.zkey,
    backend: process.env.PROVE_BACKEND || "snarkjs",
  });
  return {
    proof: result.proof,
    publicSignals: result.publicSignals,
    circuit: art.key,
  };
}

function artifactsAvailable(action, inputCount) {
  return resolveArtifacts(action, inputCount) != null;
}

module.exports = { proveWitnessJson, artifactsAvailable, resolveArtifacts };
