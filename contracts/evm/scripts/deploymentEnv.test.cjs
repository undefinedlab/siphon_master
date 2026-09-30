#!/usr/bin/env node
"use strict";

/**
 * Smoke-test deploymentEnv chain aliases (v1 DeploymentEnv.test.ts analogue).
 */
const assert = require("assert");
const { deploymentEnvLines } = require("./deploymentEnv.js");

const vault = "0x0000000000000000000000000000000000000123";

const base = deploymentEnvLines(8453, vault, 42, {
  ComplianceHub: "0x0000000000000000000000000000000000000Hub",
});
assert.ok(base.some((l) => l.includes("VAULT_KERNEL_BASE=")));
assert.ok(base.some((l) => l.startsWith("COMPLIANCE_HUB_8453=")));
assert.ok(base.some((l) => l.startsWith("ASP_COMPLIANCE_HUB_8453=")));
assert.ok(base.some((l) => l.startsWith("COMPLIANCE_HUB_ADDRESS=")));
assert.ok(!base.join("\n").includes("SEPOLIA"));

const sepolia = deploymentEnvLines(11155111, vault, 43);
assert.ok(sepolia.some((l) => l.includes("VAULT_KERNEL_SEPOLIA=")));
assert.ok(!sepolia.join("\n").includes("BASE_MAINNET"));

console.log("deploymentEnv aliases OK");
