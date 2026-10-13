"use strict";

/**
 * DELTA F-6: pin CI must fail-closed on wrap theater fields (no soft-skip of wrap pins).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CHECK_PINS = path.join(ROOT, "scripts/check-pins.cjs");

describe("DELTA F-6 wrap theater / pin gate", () => {
  test("OMEGA PoC: manifest wrap* fields exit non-zero", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delta-f6-"));
    const manifestPath = path.join(dir, "manifest.json");
    // Exact theater shape OMEGA flagged: wrap pin present while action pins incomplete.
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        ceremonyStatus: "dev-beacon",
        wrapZkeyHash: "sha256:deadbeef",
        wrapDevOnly: true,
        actionZkeyHashes: {},
      }),
    );

    const r = spawnSync(process.execPath, [CHECK_PINS], {
      env: {
        ...process.env,
        SIPHON_MANIFEST_PATH: manifestPath,
        SIPHON_ARTIFACTS_DIR: path.join(dir, "artifacts"),
        CI: "",
      },
      encoding: "utf8",
    });

    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/wrap/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("current tree pins pass without wrap fields", () => {
    const r = spawnSync(process.execPath, [CHECK_PINS], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, CI: "" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Manifest pin checks passed/);
  });
});
