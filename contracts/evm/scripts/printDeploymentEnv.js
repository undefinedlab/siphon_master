#!/usr/bin/env node
"use strict";

/**
 * Print env lines from a forge `deployed_addresses.json` (v1 ignition manifest analogue).
 *
 * Usage:
 *   node scripts/printDeploymentEnv.js deployments/chain-84532/deployed_addresses.json
 */
const fs = require("fs");
const path = require("path");

function loadDeployment(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const get = (k) => raw[k] || raw[`Greenfield#${k}`] || "";
  return {
    VaultKernel: get("VaultKernel"),
    ComplianceHub: get("ComplianceHub"),
    VerifierRegistry: get("VerifierRegistry"),
    SpendActionGroth16Router: get("SpendActionGroth16Router"),
    DeployBlock: Number(get("DeployBlock") || 0),
  };
}

const { deploymentEnvLines } = require("./deploymentEnv.js");

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/printDeploymentEnv.js <deployed_addresses.json>");
    process.exit(1);
  }
  const abs = path.resolve(file);
  const d = loadDeployment(abs);
  if (!d.VaultKernel) {
    console.error("VaultKernel missing in", abs);
    process.exit(1);
  }
  const chainMatch = abs.match(/chain-(\d+)/);
  const chainId = chainMatch ? Number(chainMatch[1]) : Number(process.env.CHAIN_ID || 0);
  if (!chainId) {
    console.error("Set CHAIN_ID or use deployments/chain-<id>/ path");
    process.exit(1);
  }
  console.log(`# chain ${chainId} — paste into app / indexer env\n`);
  deploymentEnvLines(chainId, d.VaultKernel, d.DeployBlock, d).forEach((line) =>
    console.log(line),
  );
}

main();
