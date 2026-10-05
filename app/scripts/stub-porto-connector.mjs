/**
 * Overwrite @wagmi/connectors Porto entry with a local stub so Next/webpack
 * never loads porto/internal → zod/mini (broken encode/decode re-exports).
 */
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stub = path.join(root, "src/lib/wagmi/porto-connector-stub.js");
const targets = [
  "node_modules/@wagmi/connectors/dist/esm/porto.js",
  "node_modules/@wagmi/connectors/dist/porto.js",
];

if (!existsSync(stub)) {
  console.warn("[stub-porto] stub missing, skip");
  process.exit(0);
}

let patched = 0;
for (const rel of targets) {
  const dest = path.join(root, rel);
  if (!existsSync(dest)) continue;
  copyFileSync(stub, dest);
  patched += 1;
  console.log(`[stub-porto] ${rel}`);
}

if (patched === 0) {
  console.warn("[stub-porto] @wagmi/connectors porto.js not found (ok if unused)");
}
