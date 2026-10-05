// Runnable self-check: every ZK artifact URL must go through zkUrl, and zkUrl must compose right.
//   npx tsx src/lib/zkAssets.check.ts
//
// public/zk is ~732 MB for one key set and the Base ceremony tree roughly doubles it, against a
// 200 MB compressed Amplify artifact cap that high-entropy zkeys cannot compress under. The escape
// hatch (NEXT_PUBLIC_ZK_BASE_URL) sat documented-but-unimplemented in amplify.yml, so setting it
// did nothing at all.
//
// The second half of this check matters more than the first. Routing SOME artifacts to the bucket
// and leaving others as same-origin paths is worse than routing none: the bundle stays over the cap
// because of the stragglers, and the ones left behind 404 mid-proof — after the user has already
// paid gas. So this greps the source and fails on any raw "/zk/..." literal outside this module.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

function main() {
  const SRC = path.join(process.cwd(), "src");

  // --- unset: everything stays same-origin ----------------------------------------------------
  delete process.env.NEXT_PUBLIC_ZK_BASE_URL;
  let mod = require("./zkAssets") as typeof import("./zkAssets");
  assert.strictEqual(mod.zkBase(), "", "unset must mean same-origin");
  assert.strictEqual(mod.zkUrl("/zk/withdraw2/zkey_final.zkey"), "/zk/withdraw2/zkey_final.zkey");
  assert.strictEqual(mod.zkUrl("/zk/ceremony"), "/zk/ceremony");

  // --- set: the /zk prefix is REPLACED, because the bucket holds the CONTENTS of public/zk ----
  for (const base of ["https://cdn.example.com", "https://cdn.example.com/", "https://cdn.example.com///"]) {
    process.env.NEXT_PUBLIC_ZK_BASE_URL = base;
    delete require.cache[require.resolve("./zkAssets")];
    mod = require("./zkAssets") as typeof import("./zkAssets");
    assert.strictEqual(
      mod.zkUrl("/zk/withdraw2/zkey_final.zkey"),
      "https://cdn.example.com/withdraw2/zkey_final.zkey",
      `trailing slashes must not produce a double slash (base=${JSON.stringify(base)})`,
    );
    assert.strictEqual(mod.zkUrl("/zk/ceremony"), "https://cdn.example.com/ceremony");
    assert.ok(!mod.zkUrl("/zk/a/b").includes("//a"), "no double slash anywhere in the path");
    assert.ok(!mod.zkUrl("/zk/a/b").includes("/zk/"), "the /zk prefix must not survive");
  }

  // The per-chain ceremony split must compose with the base rather than fight it.
  process.env.NEXT_PUBLIC_ZK_BASE_URL = "https://cdn.example.com";
  process.env.NEXT_PUBLIC_V3_BASE_VAULT_KERNEL ||= "0x94242AE27e0E17000Fb9d28B43118B8A7904c51A";
  process.env.NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB ||= "0x3a9Bc8000000000000000000000000000000dEaD";
  delete require.cache[require.resolve("./zkAssets")];
  delete require.cache[require.resolve("./v3/configV3")];
  const cfg = require("./v3/configV3") as typeof import("./v3/configV3");
  assert.strictEqual(cfg.zkProvingBase(8453), "https://cdn.example.com/ceremony", "Base → ceremony keys");
  assert.strictEqual(cfg.zkProvingBase(11155111), "https://cdn.example.com", "Sepolia → dev-beacon keys");

  // --- nothing may bypass zkUrl ----------------------------------------------------------------
  // middleware.ts matches the request path (server-side routing, not a fetch) and zkAssets.ts owns
  // the rewrite, so both are exempt. Everything else fetching an artifact must go through zkUrl.
  const EXEMPT = new Set(["src/middleware.ts", "src/lib/zkAssets.ts", "src/lib/zkAssets.check.ts"]);
  let raw: string;
  try {
    raw = execSync(`grep -rn -e '"/zk/' -e '\`/zk/' ${JSON.stringify(SRC)} || true`, { encoding: "utf8" });
  } catch {
    raw = "";
  }
  const offenders = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ line: path.relative(process.cwd(), l), file: path.relative(process.cwd(), l.split(":")[0]) }))
    .filter(({ file }) => !EXEMPT.has(file))
    // A line that calls zkUrl is compliant. Deliberately a whole-line test rather than "the
    // literal sits immediately inside zkUrl(": the ceremony split passes a ternary
    // (`zkUrl(cond ? "/zk/ceremony" : "/zk")`), which a tighter pattern flags as a false positive.
    // The loophole — one line both calling zkUrl and holding a second raw literal — is not worth
    // parsing TypeScript to close.
    .filter(({ line }) => !line.includes("zkUrl("))
    // Prose in a comment is not a fetch.
    .filter(({ line }) => !/^\s*\S+:\d+:\s*(\*|\/\/)/.test(line.replace(/^[^:]*:\d+:/, (m) => m)));

  assert.deepStrictEqual(
    offenders.map((o) => o.line.trim()),
    [],
    "these fetch a ZK artifact without going through zkUrl — they will 404 once artifacts move off-origin",
  );

  assert.ok(fs.existsSync(path.join(SRC, "lib/zkAssets.ts")));
  console.log(
    "zkAssets.check: OK — /zk prefix replaced cleanly for 3 base spellings, per-chain ceremony " +
      "path composes, and no source file fetches an artifact outside zkUrl",
  );
}

main();
