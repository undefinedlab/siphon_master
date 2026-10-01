/**
 * Export ceremony VKs (if needed) then upload to Devnet VK PDAs.
 *   node scripts/export-vk-accounts.mjs
 *   cd siphon-app && node ../siphon-contracts-v2/solana/scripts/deploy-vk-accounts.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

spawnSync("node", [path.join(here, "export-vk-accounts.mjs")], { stdio: "inherit", cwd: root });
spawnSync("node", [path.join(here, "upload-vk-devnet.mjs")], {
  stdio: "inherit",
  cwd: path.resolve(root, "../../siphon-app"),
});
