#!/usr/bin/env node
/**
 * CI security gate — runs deterministic self-check scripts that do not need a dev server or ZK artifacts.
 * Usage: node scripts/run-security-checks.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const CHECKS = [
  "src/lib/csp.check.ts",
  "src/lib/writeChallengeChain.check.ts",
  "src/lib/chainSwitch.check.ts",
  "src/lib/rpcQuota.check.ts",
  "src/lib/sentryRedaction.check.ts",
  "src/lib/noteAmount.check.ts",
  "src/lib/withdrawFee.check.ts",
  // Chain visibility: Sepolia is admin-only in the UI, and DEFAULT_CHAIN_ID must never be gated
  // or the anti-stranding recovery has nowhere to send a non-admin.
  "src/lib/adminChainGate.check.ts",
  // A failed compliance-fee request must not be reported to the user as a missing vault.
  "src/lib/complianceFeeError.check.ts",
  // Per-chain ASP routing: Arbitrum's ASP must never be sent Base's tokens.
  "src/lib/aspServerUrl.check.ts",
  // Overlord 2026-09-28 (Arbitrum/mock TEE): F-1 token scoping, F-3 disclosure, F-5 one host, F-6 0x0.
  "src/lib/arbitrumMockTee.check.ts",
  // Compliance fee: paid-but-unverified is retried, never paid twice.
  "src/lib/complianceFeeRetry.check.ts",
  // Every ZK artifact URL must route through zkUrl, or artifacts moved off-origin 404 mid-proof.
  "src/lib/zkAssets.check.ts",
  // A paid-but-uncredited API purchase must survive and be retryable without paying twice.
  "src/lib/apiKeys.check.ts",
  // The sanctions oracle must clear the /api/rpc call-target allowlist. It screens every
  // depositor and fails CLOSED, so an allowlist that omits it does not degrade — it stops deposits.
  "src/lib/rpcOracleAllowlist.check.ts",
  // Configuring an indexer must never be able to take v3 down: a 503 has to reach the verified
  // chain scan, not stop at the indexer.
  "src/lib/v3/stateLeavesFallback.check.ts",
  // A mined MERGE can lead its indexer event by a few seconds. The next proof must wait for that
  // leaf, and backup sync must not resurrect notes from a retired kernel while doing so.
  "src/lib/v3/stateLeafFreshness.check.ts",
  // The relay fee is a convenience charge on a permissionless exit — an unreachable or disabled
  // relayer must never make the UI ask for money or block a withdrawal.
  "src/lib/v3/withdrawCredit.check.ts",
  // A short wallet must be refused before it costs the user an approval and gas — and an
  // unreadable balance must never be mistaken for an empty one.
  "src/lib/v3/depositBalance.check.ts",
  // A swap's destination must be a real ERC-20: the kernel allowlists WETH, never the
  // native sentinel, and an output note denominated in the sentinel could never be spent.
  "src/lib/v3/swapDstAsset.check.ts",
  // Coin selection decides which of a user's notes get spent, and withdraw now MERGES on the
  // too-many-inputs message rather than dead-ending on it — so the message and its parser have to
  // stay in step. The check existed and was never wired in here.
  "src/lib/v3/planWithdrawV3.check.ts",
];

function run(label, cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    console.error(`[security:check] FAILED: ${label}`);
    process.exit(r.status ?? 1);
  }
}

run("env:check", process.execPath, [join(root, "scripts/assert-env-inlinable.mjs")]);

const bun = process.env.BUN_BIN || "bun";
for (const rel of CHECKS) {
  const path = join(root, rel);
  if (!existsSync(path)) {
    console.error(`[security:check] missing ${rel}`);
    process.exit(1);
  }
  run(rel, bun, [path]);
}

console.log(`[security:check] OK — ${CHECKS.length} self-check scripts passed`);
