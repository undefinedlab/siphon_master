"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Derive canonical 25-limb public encoding from a PROTOCOL SpendWitness JSON (Z-1).
 * Pipes witness on stdin to siphon-prove (`--witness -`) so secrets never hit disk (F-7).
 * @param {string|object} witnessJson
 * @returns {string[]}
 */
function deriveExpectedPublics(witnessJson) {
  const json =
    typeof witnessJson === "string" ? witnessJson : JSON.stringify(witnessJson);

  const r = spawnSync(
    "cargo",
    ["run", "-q", "-p", "siphon-prove", "--", "--witness", "-"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: json,
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  if (r.status !== 0) {
    throw new Error(
      `deriveExpectedPublics: spend-core failed\n${r.stderr || r.stdout}`,
    );
  }

  const limbs = JSON.parse(r.stdout.trim());
  if (!Array.isArray(limbs) || limbs.length !== 25) {
    throw new Error(`deriveExpectedPublics: expected 25 limbs, got ${limbs?.length}`);
  }
  return limbs.map(String);
}

module.exports = { deriveExpectedPublics };
