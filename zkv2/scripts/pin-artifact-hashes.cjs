#!/usr/bin/env node
/**
 * Pin sha256 of local Groth16 action artifacts into manifest/universal-spend-v1.json (GF-M5).
 *
 * Usage:
 *   node scripts/pin-artifact-hashes.cjs
 *   node scripts/pin-artifact-hashes.cjs --require-all   # fail if any action zkey missing
 *
 * Does NOT commit ceremony status=reviewed — that stays for MPC finalize.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CIRCUITS } = require("./lib/circuits.cjs");

const root = path.resolve(__dirname, "..");
const art = path.join(root, "artifacts");
const manifestPath = path.join(root, "manifest/universal-spend-v1.json");
const requireAll = process.argv.includes("--require-all");

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const actionZkeyHashes = {};
const actionVkHashes = {};
let missing = 0;

for (const { key } of CIRCUITS) {
  const zkey = path.join(art, key, "zkey_final.zkey");
  const vk = path.join(art, key, "verification_key.json");
  if (!fs.existsSync(zkey) || !fs.existsSync(vk)) {
    console.error(`MISSING ${key}`);
    missing++;
    continue;
  }
  actionZkeyHashes[key] = `sha256:${sha256File(zkey)}`;
  actionVkHashes[key] = `sha256:${sha256File(vk)}`;
  console.log(`OK   ${key}`);
}

if (requireAll && missing) {
  console.error(`--require-all: ${missing} circuits missing artifacts`);
  process.exit(1);
}
if (Object.keys(actionZkeyHashes).length === 0) {
  console.error("No action zkeys found under artifacts/ — run npm run build first");
  process.exit(2);
}

manifest.actionZkeyHashes = actionZkeyHashes;
manifest.actionVkHashes = actionVkHashes;
manifest.ceremonyStatus = manifest.ceremonyStatus || "dev-beacon";
manifest.pinsUpdatedAt = new Date().toISOString();

// Drop legacy wrap pin fields if present.
delete manifest.wrapVerifierContract;
delete manifest.wrapNPublic;
delete manifest.wrapDevOnly;
delete manifest.wrapZkeyHash;
delete manifest.wrapBytecodeHash;

manifest.actionVerifierRouter = manifest.actionVerifierRouter || "SpendActionGroth16Router";
manifest.notes =
  "Production gate: SpendActionGroth16Router + 14 action verifiers. Equality wrap removed.";

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nPinned ${Object.keys(actionZkeyHashes).length} action circuits → ${manifestPath}`);
console.log(`ceremonyStatus=${manifest.ceremonyStatus}`);
