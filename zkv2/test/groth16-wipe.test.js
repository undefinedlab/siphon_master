"use strict";

/**
 * DELTA F-4: proveGroth16 must not leave witness.wtns (nullifiers/secrets) on disk.
 * Uses real withdraw3 artifacts + snarkjs (no jest mocks).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { proveGroth16, artifactPaths } = require("../scripts/lib/groth16-prove.cjs");
const { witnessToCircomInput } = require("../scripts/lib/witness-to-input.cjs");

const ROOT = path.resolve(__dirname, "..");
const WITHDRAW_W3 = path.join(ROOT, "test-vectors/withdraw-w3-ok.json");
const ARTIFACTS_DIR = process.env.PROTOCOL_ARTIFACTS_DIR || path.join(ROOT, "artifacts");
const WITHDRAW3 = artifactPaths(ARTIFACTS_DIR, "withdraw3");
const ARTIFACTS_PRESENT = [WITHDRAW3.wasm, WITHDRAW3.zkey].every((p) => fs.existsSync(p));

describe("DELTA F-4 witness residue wipe", () => {
  const circomInput = witnessToCircomInput(JSON.parse(fs.readFileSync(WITHDRAW_W3, "utf8")));

  test("caller-owned workDir: witness.wtns deleted after prove", async () => {
    if (!ARTIFACTS_PRESENT) {
      console.warn("skip: withdraw3 artifacts missing — run npm run build");
      return;
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "delta-f4-owned-"));
    const wtnsPath = path.join(workDir, "witness.wtns");

    await proveGroth16({
      input: circomInput,
      wasm: WITHDRAW3.wasm,
      zkey: WITHDRAW3.zkey,
      workDir,
      backend: "snarkjs",
    });

    expect(fs.existsSync(wtnsPath)).toBe(false);
    expect(fs.existsSync(workDir)).toBe(true);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test("auto workDir: entire temp dir removed after prove", async () => {
    if (!ARTIFACTS_PRESENT) {
      console.warn("skip: withdraw3 artifacts missing — run npm run build");
      return;
    }
    let capturedDir = null;
    const origMkdtemp = fs.mkdtempSync.bind(fs);
    fs.mkdtempSync = (...args) => {
      capturedDir = origMkdtemp(...args);
      return capturedDir;
    };

    try {
      await proveGroth16({
        input: circomInput,
        wasm: WITHDRAW3.wasm,
        zkey: WITHDRAW3.zkey,
        backend: "snarkjs",
      });
      expect(capturedDir).not.toBeNull();
      expect(fs.existsSync(capturedDir)).toBe(false);
      expect(fs.existsSync(path.join(capturedDir, "witness.wtns"))).toBe(false);
    } finally {
      fs.mkdtempSync = origMkdtemp;
      if (capturedDir && fs.existsSync(capturedDir)) {
        fs.rmSync(capturedDir, { recursive: true, force: true });
      }
    }
  });
});
