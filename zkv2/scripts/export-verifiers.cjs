#!/usr/bin/env node
/**
 * Export zkeys → Solidity verifiers for siphon-contracts-v2.
 *
 *   node scripts/export-verifiers.cjs
 *   node scripts/export-verifiers.cjs --artifacts ./artifacts --contracts ../siphon-contracts-v2/evm/src/verifiers
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { CIRCUITS } = require("./lib/circuits.cjs");

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return path.resolve(i === -1 ? fallback : process.argv[i + 1]);
}

const root = path.resolve(__dirname, "..");
const artifactsDir = option("--artifacts", path.join(root, "artifacts"));
const contractsDir = option(
  "--contracts",
  path.resolve(root, "../siphon-contracts-v2/evm/src/verifiers"),
);
const snarkjs = path.join(root, "node_modules/.bin/snarkjs");
if (!fs.existsSync(snarkjs)) throw new Error("run npm install in siphon-zkv2");

fs.mkdirSync(contractsDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "siphon-v2-verifiers-"));

try {
  for (const { key, verifier, nPublic } of CIRCUITS) {
    const dir = path.join(artifactsDir, key);
    const zkey = path.join(dir, "zkey_final.zkey");
    const vkey = path.join(dir, "verification_key.json");
    if (!fs.existsSync(zkey)) throw new Error(`missing ${zkey}`);

    const vk = JSON.parse(fs.readFileSync(vkey, "utf8"));
    if (Number(vk.nPublic) !== nPublic) {
      throw new Error(`${key} nPublic=${vk.nPublic} expected ${nPublic}`);
    }

    const gen = path.join(tmp, `${key}.sol`);
    execFileSync(snarkjs, ["zkey", "export", "solidityverifier", zkey, gen], {
      stdio: "inherit",
    });

    let src = fs.readFileSync(gen, "utf8");
    src = src.replace("contract Groth16Verifier", `contract ${verifier}`);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(zkey)).digest("hex");
    src = src.replace(
      "// SPDX-License-Identifier: GPL-3.0\n",
      `// SPDX-License-Identifier: GPL-3.0\n// siphon-zkv2 ${key} zkey sha256=${digest}\n`,
    );
    src = `${src.replace(/[ \t]+$/gm, "").trimEnd()}\n`;
    fs.writeFileSync(path.join(contractsDir, `${verifier}.sol`), src);
    console.log(`OK ${verifier} (${nPublic} signals)`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
