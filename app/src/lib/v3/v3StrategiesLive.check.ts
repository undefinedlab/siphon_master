// Runnable self-check: a FULLY-configured v3 chain must allow arming.
//   npx tsx src/lib/v3/v3StrategiesLive.check.ts
//
// Separate from strategyGuard.check.ts because configV3 reads its ENV map once at module load and
// the `?${Math.random()}` cache-bust does NOT re-evaluate under tsx — so the "v3 fully wired" case
// needs its own process, with env set before the first import.
//
// This is the case that flipped: strategies used to be refused on every v3 chain, because arming
// only ever targeted v2. strategyOrchestrateV3 gives v3 its own path, so a wired v3 chain must now
// be ALLOWED — while a half-wired one (kernel but no executor/ASP) must still fail before the fee.
process.env.NEXT_PUBLIC_V3_SEPOLIA_VAULT_KERNEL = "0x069445e2e0e5E15ACad75Ddc2dEc4e64A660003d";
process.env.NEXT_PUBLIC_V3_SEPOLIA_COMPLIANCE_HUB = "0x667166fe7bfb51fd2b3b9281af0a9dfeb5845288";
process.env.NEXT_PUBLIC_V3_SEPOLIA_EXECUTOR_URL = "https://executor.invalid";
process.env.NEXT_PUBLIC_V3_SEPOLIA_ASP_URL = "https://asp.invalid";

import assert from "node:assert";

// DYNAMIC import, deliberately: a static `import` is hoisted above the process.env assignments
// above, so configV3's ENV map would be evaluated before any of them ran and every assertion here
// would test the unconfigured case while appearing to test the configured one.
const SEPOLIA = 11155111;

async function main() {
const {
  requireStrategySupport,
  requireV2StrategyPath,
  strategiesSupported,
  v2StrategyPathSupported,
  v3Deployed,
  v3StrategiesLive,
} = await import("./configV3");

assert.equal(v3Deployed(SEPOLIA), true, "fixture drift: kernel + hub are set");
assert.equal(v3StrategiesLive(SEPOLIA), true, "kernel + executor + ASP => the v3 path is live");
assert.equal(
  strategiesSupported(SEPOLIA),
  true,
  "a fully-wired v3 chain must ALLOW arming — it routes through strategyOrchestrateV3",
);
assert.doesNotThrow(() => requireStrategySupport(SEPOLIA));

// The v2 internals stay refused on this chain no matter how well v3 is configured.
assert.equal(v2StrategyPathSupported(SEPOLIA), false);
assert.throws(() => requireV2StrategyPath(SEPOLIA), /v2 arming path cannot be used here/);

console.log("v3StrategiesLive.check: OK — a wired v3 chain arms via v3, and never via v2");
}

main();
