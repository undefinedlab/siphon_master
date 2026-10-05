/**
 * Release check: fail when CEREMONY.json is still DEV-beacon under STRICT_BUILD /
 * REQUIRE_MPC_CEREMONY / production env. Safe for testnet deploys that omit those flags.
 *
 * Usage: bun scripts/assert-zk-ceremony.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeCeremonyKind,
  releaseCeremonyError,
} from "../src/lib/zkCeremony.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ceremonyPath = join(root, "public/zk/CEREMONY.json");

let kindRaw = "";
try {
  const data = JSON.parse(readFileSync(ceremonyPath, "utf8"));
  kindRaw = String(data.kind || "");
} catch (e) {
  console.error("[assert-zk-ceremony] cannot read", ceremonyPath, e);
  process.exit(1);
}

const kind = normalizeCeremonyKind(kindRaw);
const err = releaseCeremonyError(kind, process.env);
if (err) {
  console.error("[assert-zk-ceremony]", err);
  console.error(`  file: ${ceremonyPath}`);
  console.error(`  kind: ${kindRaw || "(missing)"}`);
  process.exit(1);
}

console.log(`[assert-zk-ceremony] ok — kind=${kind} (release gate not tripped or mpc)`);
