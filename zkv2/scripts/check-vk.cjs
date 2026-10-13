#!/usr/bin/env node
/** CI gate: verification keys must match scripts/lib/circuits.cjs nPublic counts. */
const fs = require("fs");
const path = require("path");
const { CIRCUITS } = require("./lib/circuits.cjs");

const root = path.resolve(__dirname, "..");
const base = path.join(root, "artifacts");

let failed = 0;
let checked = 0;

for (const { key, nPublic } of CIRCUITS) {
  const vkPath = path.join(base, key, "verification_key.json");
  if (!fs.existsSync(vkPath)) {
    console.error(`MISSING ${vkPath}`);
    failed++;
    continue;
  }
  const vk = JSON.parse(fs.readFileSync(vkPath, "utf8"));
  checked++;
  if (Number(vk.nPublic) !== nPublic) {
    console.error(`FAIL ${key}: nPublic=${vk.nPublic} expected ${nPublic}`);
    failed++;
  } else {
    console.log(`OK   ${key}: nPublic=${vk.nPublic}`);
  }
}

if (checked === 0) {
  console.error(`No VKs under ${base} — run npm run build`);
  process.exit(2);
}
if (failed) process.exit(1);
console.log(`\nAll ${checked} VKs match registry.`);
