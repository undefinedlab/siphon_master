#!/usr/bin/env node
"use strict";

/**
 * DELTA F-1/F-4/F-7 — doc alignment blockers (contracts-v2 ↔ zkv2 ↔ aspv2).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/**
 * Single source of truth for the protocol version.
 *
 * This test hardcoded PROTOCOL_VERSION in seven places. The docs moved to 3.5.0 and the assertions did
 * not, so `npm run test:docs` — which the README lists as part of the build and which runs in
 * CI — failed on every checkout. Derive it from the normative spec instead, so a version bump
 * is one edit in zkv2 rather than seven here.
 */
const PROTOCOL_VERSION = (() => {
  const specPath = path.join(ROOT, "../siphon-zkv2/docs/PROTOCOL.md");
  if (fs.existsSync(specPath)) {
    const m = fs.readFileSync(specPath, "utf8").match(/\|\s*\*\*Version\*\*\s*\|\s*([0-9]+\.[0-9]+\.[0-9]+)/);
    if (m) return m[1];
  }
  // zkv2 is not always checked out beside us (CI, a contracts-only clone).
  return "3.5.0";
})();

function mustExist(rel) {
  const p = path.join(ROOT, rel);
  assert.ok(fs.existsSync(p), `missing doc: ${rel}`);
  return read(rel);
}

// F-7 / F-1: closure tracker exists; no broken OMEGA-CARRYFORWARD link
const arch = mustExist("docs/ARCHITECTURE.md");
assert.ok(!arch.includes("OMEGA-CARRYFORWARD.md"), "F-1: stale OMEGA-CARRYFORWARD link");
assert.ok(arch.includes("OMEGA-CLOSURE.md"), "F-7: OMEGA-CLOSURE link");
assert.ok(arch.includes("INTEGRATION.md"), "F-4: INTEGRATION link");

mustExist("docs/OMEGA-CLOSURE.md");
const integration = mustExist("docs/INTEGRATION.md");
assert.ok(integration.includes("export_aspv2_env.sh"), "F-4: aspv2 export script");
assert.ok(integration.includes("vaultRoots"), "F-4: zkv2 vaultRoots");
assert.ok(integration.includes("userSalt"), "F-4: aspv2 screen body");

// F-2: protocol version refs in spec + privacy (version derived above, not hardcoded)
const pubInputs = read("spec/public-inputs.md");
assert.ok(pubInputs.includes(PROTOCOL_VERSION), "F-1: spec/public-inputs version");
const modules = read("spec/modules.md");
assert.ok(modules.includes(PROTOCOL_VERSION), "F-1: spec/modules version");
const privacy = read("docs/PRIVACY.md");
assert.ok(privacy.includes(PROTOCOL_VERSION), "F-1: PRIVACY version");

// F-2: protocol version refs
const readme = read("README.md");
assert.ok(readme.includes(PROTOCOL_VERSION), "F-2: README version");

// F-3: DEPLOY GF-M1 vaultRoots
const deploy = read("docs/DEPLOY.md");
assert.ok(deploy.includes("vaultRoots"), "F-3: DEPLOY vaultRoots");
assert.ok(deploy.includes("proveSpend"), "F-3: DEPLOY proveSpend");

// F-5: bootstrap env documented
const envEx = read("evm/.env.example");
assert.ok(envEx.includes("COMPLIANCE_HUB_ADDRESS"), "F-5: hub address");
assert.ok(envEx.includes("ADMITTED_ROOT"), "F-5: admitted root");
assert.ok(envEx.includes("REVOKED_ROOT"), "F-5: revoked root");

// F-6: GATE-REVIEW scope updated
const gate = read("docs/GATE-REVIEW.md");
assert.ok(!gate.includes("no production Solidity"), "F-6: stale scope line");
assert.ok(gate.includes(PROTOCOL_VERSION), "F-6: GATE-REVIEW version");
assert.ok(!gate.includes("still no production contracts"), "F-3/GATE: stale next line");

// F-3: ARCHITECTURE §7 shipped header
assert.ok(arch.includes("Modules (shipped"), "F-3: ARCHITECTURE §7 header");
assert.ok(!arch.includes("Solidity later"), "F-3: no Solidity later");
assert.ok(!arch.includes("No production bytecode until"), "F-3: no stale bytecode gate");

// GATE §7 deposit bind row
assert.ok(gate.includes("VaultKernel.deposit"), "GATE: deposit bind shipped");
assert.ok(!gate.includes("Design before M4 code"), "GATE: no stale M4 design row");

// Bootstrap root matches vendored zkv2 fixture (aspv2 export parity)
const emptyRoot = JSON.parse(
  read("fixtures/zkv2/test-vectors/asp/empty-root.json"),
).emptyRoot;
assert.ok(envEx.includes(emptyRoot.slice(0, 12)), "bootstrap root in .env.example");

console.log("docs-alignment OK");
