#!/usr/bin/env node
/**
 * CI gate (GF-M5): manifest action pins must match on-disk artifacts when present.
 * Always requires actionZkeyHashes for every circuit in CIRCUITS.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CIRCUITS } = require("./lib/circuits.cjs");

const root = path.resolve(__dirname, "..");
const art = process.env.SIPHON_ARTIFACTS_DIR
  ? path.resolve(process.env.SIPHON_ARTIFACTS_DIR)
  : path.join(root, "artifacts");
const manifestPath = process.env.SIPHON_MANIFEST_PATH
  ? path.resolve(process.env.SIPHON_MANIFEST_PATH)
  : path.join(root, "manifest/universal-spend-v1.json");
const requireAll = process.argv.includes("--require-all") || process.env.CI === "true";

function sha256File(p) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`;
}

const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
let failed = 0;

if (m.wrapZkeyHash || m.wrapBytecodeHash || m.wrapVerifierContract || m.wrapDevOnly) {
  console.error("FAIL manifest still has wrap* fields — equality wrap was removed");
  failed++;
}

if (!m.actionZkeyHashes || typeof m.actionZkeyHashes !== "object") {
  console.error("FAIL manifest.actionZkeyHashes missing");
  failed++;
} else {
  for (const { key } of CIRCUITS) {
    if (!m.actionZkeyHashes[key]) {
      console.error(`FAIL actionZkeyHashes.${key} missing`);
      failed++;
      continue;
    }
    const zkey = path.join(art, key, "zkey_final.zkey");
    if (!fs.existsSync(zkey)) {
      if (requireAll) {
        console.error(`FAIL ${key} zkey missing under artifacts/`);
        failed++;
      } else {
        console.log(`SKIP ${key} (no local artifact)`);
      }
      continue;
    }
    const got = sha256File(zkey);
    if (got !== m.actionZkeyHashes[key]) {
      console.error(`FAIL ${key} zkey pin drift\n  manifest ${m.actionZkeyHashes[key]}\n  disk     ${got}`);
      failed++;
    } else {
      console.log(`OK   ${key} zkey pin`);
    }
  }
}

if (!m.actionVkHashes || typeof m.actionVkHashes !== "object") {
  console.error("FAIL manifest.actionVkHashes missing");
  failed++;
} else {
  for (const { key } of CIRCUITS) {
    if (!m.actionVkHashes[key]) {
      console.error(`FAIL actionVkHashes.${key} missing`);
      failed++;
      continue;
    }
    const vk = path.join(art, key, "verification_key.json");
    if (!fs.existsSync(vk)) {
      if (requireAll) {
        console.error(`FAIL ${key} vk missing under artifacts/`);
        failed++;
      } else {
        console.log(`SKIP ${key} vk (no local artifact)`);
      }
      continue;
    }
    const got = sha256File(vk);
    if (got !== m.actionVkHashes[key]) {
      console.error(`FAIL ${key} vk pin drift\n  manifest ${m.actionVkHashes[key]}\n  disk     ${got}`);
      failed++;
    } else {
      console.log(`OK   ${key} vk pin`);
    }
  }
}

if (failed) process.exit(1);
console.log("\nManifest pin checks passed.");
