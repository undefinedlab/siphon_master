"use strict";

/**
 * @siphon/zkv2-sdk — PROTOCOL spend prove helpers (M6 / GF-H1).
 *
 * T0 (local) is the default. T1 (hosted) requires an explicit ConsentReceipt.
 *
 * Note (F-10): ConsentReceipt is a local UX/freeze-list receipt — not cryptographic
 * authentication of a remote prover. The hosted prover must authenticate the user.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  circuitKeyForAction,
  PUBLIC_WIDTH,
} = require("../scripts/lib/circuits.cjs");
const {
  proveGroth16,
  artifactPaths,
  verifyProof,
} = require("../scripts/lib/groth16-prove.cjs");
const { deriveExpectedPublics } = require("../scripts/lib/spend-core-publics.cjs");
const { witnessToCircomInput } = require("../scripts/lib/witness-to-input.cjs");
const aspClient = require("./aspClient.js");
const { planWithdraw } = require("./planWithdraw.js");

/** Fields that leave the device on a hosted prove (T1). OVERLORD F-7: include D1 assets. */
const HOSTED_DISCLOSED_FIELDS = Object.freeze([
  "nullifiers",
  "secrets",
  "amounts",
  "labels",
  "assetIds",
  "inAssetId",
  "merklePaths",
  "aspPaths",
  "smtPaths",
  "rawPayee",
]);

/** Recursive key-sort for stable consent digests (F-6). */
function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const k of Object.keys(value).sort()) {
    out[k] = canonicalize(value[k]);
  }
  return out;
}

/**
 * Stable digest of witness + prove scope for consent binding (GF-H1 / Z-3).
 * @param {object} input
 * @param {{ action?: number, inputCount?: number, circuit?: string }} [scope]
 * @returns {string} hex sha256
 */
function witnessDigest(input, scope = {}) {
  const canonical = JSON.stringify(canonicalize(input || {}));
  const parts = [canonical];
  if (scope.action !== undefined) parts.push(`action:${scope.action}`);
  if (scope.inputCount !== undefined) parts.push(`inputCount:${scope.inputCount}`);
  if (scope.circuit !== undefined) parts.push(`circuit:${scope.circuit}`);
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

function proveScopeDigest(input, action, inputCount) {
  return witnessDigest(input, {
    action,
    inputCount,
    circuit: circuitKeyForAction(action, inputCount),
  });
}

function assertConsentCoversHostedFields(disclosedFields) {
  if (!Array.isArray(disclosedFields) || disclosedFields.length === 0) {
    throw new Error("consentHostedProve: disclosedFields required");
  }
  for (const req of HOSTED_DISCLOSED_FIELDS) {
    if (!disclosedFields.includes(req)) {
      throw new Error(
        `consentHostedProve: disclosedFields must include "${req}" (GF-H1 freeze-list)`,
      );
    }
  }
}

/**
 * Local UX consent receipt for T1 hosted prove (not prover auth — F-10).
 * Always recomputes witnessDigest from `witness` (ignores caller-supplied digest — F-6).
 *
 * @param {{ witness: object, action: number, inputCount: number, disclosedFields?: string[], note?: string }} opts
 * @returns {{ consentId: string, ts: string, disclosedFields: string[], witnessDigest: string, note?: string }}
 */
function consentHostedProve(opts = {}) {
  if (opts.action === undefined || opts.inputCount === undefined) {
    throw new Error("consentHostedProve: action and inputCount required (Z-3 scope bind)");
  }
  if (!opts.witness || typeof opts.witness !== "object") {
    throw new Error("consentHostedProve: witness object required");
  }
  const witnessDigestValue = proveScopeDigest(
    opts.witness,
    opts.action,
    opts.inputCount,
  );
  const disclosedFields = opts.disclosedFields
    ? [...opts.disclosedFields]
    : [...HOSTED_DISCLOSED_FIELDS];
  assertConsentCoversHostedFields(disclosedFields);
  const consentId = crypto.randomBytes(16).toString("hex");
  return {
    consentId,
    ts: new Date().toISOString(),
    disclosedFields,
    witnessDigest: witnessDigestValue,
    note: opts.note,
  };
}

/**
 * Refuse submit if proof publics ≠ expected 25 limbs (GF-H1 / GF-H6).
 * @param {string[]|bigint[]|number[]} expected
 * @param {string[]|bigint[]|number[]} proofPublics
 */
function assertPublicsMatch(expected, proofPublics) {
  if (!expected || expected.length !== PUBLIC_WIDTH) {
    throw new Error(`assertPublicsMatch: expected ${PUBLIC_WIDTH} limbs`);
  }
  if (!proofPublics || proofPublics.length !== PUBLIC_WIDTH) {
    throw new Error(`assertPublicsMatch: proof has ${proofPublics?.length} publics`);
  }
  for (let i = 0; i < PUBLIC_WIDTH; i++) {
    const a = BigInt(expected[i]);
    const b = BigInt(proofPublics[i]);
    if (a !== b) {
      throw new Error(`assertPublicsMatch: limb[${i}] expected ${a} got ${b}`);
    }
  }
  return true;
}

/**
 * GF-M1: roots on the witness must match vault-current roots before submit.
 * @param {{ stateRoot: string|bigint, admittedRoot: string|bigint, revokedRoot: string|bigint }} witnessRoots
 * @param {{ stateRoot: string|bigint, admittedRoot: string|bigint, revokedRoot: string|bigint }} vaultRoots
 */
function assertRootsCurrent(witnessRoots, vaultRoots) {
  for (const k of ["stateRoot", "admittedRoot", "revokedRoot"]) {
    if (BigInt(witnessRoots[k]) !== BigInt(vaultRoots[k])) {
      throw new Error(
        `assertRootsCurrent: ${k} drifted — resync + reprove (GF-M1)`,
      );
    }
  }
  return true;
}

function assertHostedConsent(consent, input, action, inputCount) {
  if (!consent || !consent.consentId) {
    throw new Error(
      "proveSpend: hosted (T1) requires consentHostedProve() receipt (GF-H1)",
    );
  }
  assertConsentCoversHostedFields(consent.disclosedFields || []);
  const dig = proveScopeDigest(input, action, inputCount);
  if (!consent.witnessDigest || consent.witnessDigest !== dig) {
    throw new Error(
      "proveSpend: consent.witnessDigest mismatch — re-consent after witness change (GF-H1)",
    );
  }
}

function parseWitnessJson(witnessJson) {
  return typeof witnessJson === "string" ? JSON.parse(witnessJson) : witnessJson;
}

function looksLikeCircomInput(input) {
  return (
    input &&
    typeof input === "object" &&
    (Array.isArray(input.publicInputs) || input.publicInputs !== undefined)
  );
}

function sameStrArr(a, b) {
  const aa = Array.isArray(a) ? a.map(String) : [String(a)];
  const bb = Array.isArray(b) ? b.map(String) : [String(b)];
  if (aa.length !== bb.length) return false;
  return aa.every((v, i) => v === bb[i]);
}

/** Bind opts.input private wires to witnessJson (F-8) — ignores publicInputs drift. */
function assertInputMatchesWitnessJson(input, witnessObj, action, inputCount) {
  if (Number(witnessObj.action) !== Number(action)) {
    throw new Error("proveSpend: witnessJson.action !== action");
  }
  if (Number(witnessObj.inputCount) !== Number(inputCount)) {
    throw new Error("proveSpend: witnessJson.inputCount !== inputCount");
  }
  if (!input || typeof input !== "object") {
    throw new Error("proveSpend: input required");
  }

  if (looksLikeCircomInput(input)) {
    const circom = witnessToCircomInput(witnessObj);
    const keys = [
      "inNullifier",
      "inSecret",
      "inLabel",
      "inValue",
      "inAssetId",
      "outNullifier",
      "outSecret",
    ];
    for (const k of keys) {
      if (circom[k] === undefined && input[k] === undefined) continue;
      if (!sameStrArr(input[k], circom[k])) {
        throw new Error(
          `proveSpend: input/witnessJson mismatch on ${k} (F-8)`,
        );
      }
    }
    return;
  }

  const wInputs = witnessObj.inputs || [];
  const iInputs = input.inputs || [];
  if (wInputs.length !== iInputs.length) {
    throw new Error("proveSpend: input/witnessJson inputs length mismatch (F-8)");
  }
  for (let i = 0; i < wInputs.length; i++) {
    for (const k of ["inNullifier", "inSecret", "inLabel", "inValue", "inAssetId"]) {
      if (String(wInputs[i][k] ?? "") !== String(iInputs[i][k] ?? "")) {
        throw new Error(
          `proveSpend: input/witnessJson mismatch on inputs[${i}].${k} (F-8)`,
        );
      }
    }
  }
}

/**
 * Prove a spend. Default prefer="local" (T0). Hosted requires consent.
 *
 * @param {object} opts
 * @param {0|1|2|3|4} opts.action
 * @param {number} opts.inputCount
 * @param {object} opts.input circom witness object OR PROTOCOL SpendWitness
 * @param {"local"|"hosted"} [opts.prefer="local"]
 * @param {ReturnType<typeof consentHostedProve>} [opts.consent] required if prefer=hosted
 * @param {string} [opts.artifactsDir]
 * @param {string|object} opts.witnessJson PROTOCOL SpendWitness JSON — spend-core derives publics (Z-1)
 * @param {string[]|bigint[]} opts.expectedPublics required — must match spend-core derivation
 * @param {{ stateRoot: string|bigint, admittedRoot: string|bigint, revokedRoot: string|bigint }} opts.vaultRoots GF-M1 TOCTOU gate (required — F-5)
 * @param {(body: object) => Promise<{proof: object, publicSignals: string[]}>} [opts.hostedProve]
 */
async function proveSpend(opts) {
  if (!opts.expectedPublics) {
    throw new Error(
      "proveSpend: expectedPublics required — recompute 25 limbs locally before prove/submit (GF-H1/H6)",
    );
  }
  if (!opts.witnessJson) {
    throw new Error(
      "proveSpend: witnessJson required — expectedPublics must bind spend-core derivation (Z-1)",
    );
  }
  if (!opts.vaultRoots) {
    throw new Error(
      "proveSpend: vaultRoots required — assert current ComplianceHub/NoteTree roots before prove (F-5/GF-M1)",
    );
  }
  const derived = deriveExpectedPublics(opts.witnessJson);
  assertPublicsMatch(opts.expectedPublics, derived);

  const w = parseWitnessJson(opts.witnessJson);
  assertRootsCurrent(
    {
      stateRoot: w.stateRoot,
      admittedRoot: w.admittedRoot,
      revokedRoot: w.revokedRoot,
    },
    opts.vaultRoots,
  );

  // Align Circom publicInputs mapping to spend-core when rebuilding from witness (F-9 path).
  w.expectedPublic = derived;
  assertInputMatchesWitnessJson(opts.input, w, opts.action, opts.inputCount);

  const prefer = opts.prefer || "local";
  const artifactsDir =
    opts.artifactsDir ||
    process.env.PROTOCOL_ARTIFACTS_DIR ||
    path.resolve(__dirname, "../artifacts");
  const key = circuitKeyForAction(opts.action, opts.inputCount);
  const paths = artifactPaths(artifactsDir, key);

  if (prefer === "hosted") {
    assertHostedConsent(opts.consent, opts.input, opts.action, opts.inputCount);
    if (typeof opts.hostedProve !== "function") {
      throw new Error("proveSpend: hostedProve callback required for T1");
    }
    const remote = await opts.hostedProve({
      circuit: key,
      input: opts.input,
      consent: opts.consent,
    });
    assertPublicsMatch(opts.expectedPublics, remote.publicSignals);
    if (!fs.existsSync(paths.vkey)) {
      throw new Error(
        `proveSpend: missing vkey ${paths.vkey} — cannot verify hosted proof (F-2)`,
      );
    }
    const ok = await verifyProof(paths.vkey, remote.publicSignals, remote.proof);
    if (!ok) {
      throw new Error("proveSpend: hosted Groth16 verify failed (F-2)");
    }
    return {
      proof: remote.proof,
      publicSignals: remote.publicSignals,
      circuit: key,
      mode: "hosted",
      consentId: opts.consent.consentId,
    };
  }

  for (const p of [paths.wasm, paths.zkey]) {
    if (!fs.existsSync(p)) {
      throw new Error(`proveSpend: missing artifact ${p} — run npm run build`);
    }
  }

  const result = await proveGroth16({
    input: opts.input,
    wasm: paths.wasm,
    zkey: paths.zkey,
    backend: opts.backend || "snarkjs",
  });

  assertPublicsMatch(opts.expectedPublics, result.publicSignals);

  return {
    proof: result.proof,
    publicSignals: result.publicSignals,
    circuit: key,
    mode: "local",
    backend: result.backend,
    witness_ms: result.witness_ms,
    prove_ms: result.prove_ms,
  };
}

module.exports = {
  HOSTED_DISCLOSED_FIELDS,
  PUBLIC_WIDTH,
  circuitKeyForAction,
  canonicalize,
  witnessDigest,
  proveScopeDigest,
  consentHostedProve,
  assertPublicsMatch,
  assertRootsCurrent,
  deriveExpectedPublics,
  proveSpend,
  artifactPaths,
  aspClient,
  planWithdraw,
};
