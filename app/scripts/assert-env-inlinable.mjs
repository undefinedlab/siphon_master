#!/usr/bin/env node
/**
 * Next.js replaces `process.env.NEXT_PUBLIC_X` only where it is written as a LITERAL member
 * expression. A computed `process.env[key]` survives into the client bundle, where `process.env`
 * holds none of these — so the lookup yields undefined and the caller silently takes whatever
 * fallback it defines.
 *
 * That is not a loud failure. configV3.ts read its addresses this way, so every v3 address
 * resolved to the zero address, `v3Deployed()` reported false, and the dashboard quietly routed
 * deposits and balance reads down the retired v2 path against a decommissioned indexer. A unit
 * test cannot catch it: under Node `process.env` is populated and the code passes.
 *
 * Run: node scripts/assert-env-inlinable.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;
const COMPUTED_ENV = /process\.env\s*\[/;

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(path) ? [path] : [];
  });
}

const offenders = walk(ROOT).flatMap((file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => ({ file, line: i + 1, text: line.trim() }))
    .filter(({ text }) => COMPUTED_ENV.test(text) && !text.startsWith("*") && !text.startsWith("//")),
);

if (offenders.length > 0) {
  console.error(
    "Computed process.env[...] access found. Next.js cannot inline these, so they read as\n" +
      "undefined in the browser and the caller silently falls back. Read through a literal map\n" +
      "instead — see the ENV block in src/lib/v3/configV3.ts.\n",
  );
  for (const { file, line, text } of offenders) {
    console.error(`  ${file.replace(ROOT, "src")}:${line}  ${text}`);
  }
  process.exit(1);
}

console.log("env-inlinable: OK — no computed process.env access in src/");
