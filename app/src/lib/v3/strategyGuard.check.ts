// Runnable self-check for the v3 strategy guard — no test framework in this repo.
//   npx tsx src/lib/v3/strategyGuard.check.ts
//
// The guard exists because strategy arming still targets the v2 entrypoint (multiLegBuilder.ts:96)
// and v2 notes (localNoteStore), while deposit/balance/withdraw route to the v3 kernel wherever v3
// is configured. Without it, arming on a v3 chain charges the arming fee and fires a split against
// a vault where the user holds nothing.
//
// env is read through configV3's literal ENV map at module load, so each case sets env and then
// imports a FRESH copy of the module.
import assert from "node:assert";

const KERNEL = "0x069445e2e0e5E15ACad75Ddc2dEc4e64A660003d";
const HUB = "0x667166fe7bfb51fd2b3b9281af0a9dfeb5845288";
const SEPOLIA = 11155111;
const BASE = 8453;

async function freshConfig() {
  // Bust the module cache so the ENV map is re-evaluated against the env set above.
  return import(`./configV3?${Math.random()}`);
}

async function main() {
  // ---- v3 kernel live but the v3 STRATEGY path unconfigured => still refused -----------------
  // The guard used to mean "v3 deployed => no strategies at all", because arming only ever
  // targeted v2. strategyOrchestrateV3 changed that: a v3 chain CAN now arm, but only when the
  // executor and ASP are both reachable. Half-configured must still fail loudly, before the fee.
  process.env.NEXT_PUBLIC_V3_SEPOLIA_VAULT_KERNEL = KERNEL;
  process.env.NEXT_PUBLIC_V3_SEPOLIA_COMPLIANCE_HUB = HUB;
  delete process.env.NEXT_PUBLIC_V3_SEPOLIA_EXECUTOR_URL;
  delete process.env.NEXT_PUBLIC_V3_SEPOLIA_ASP_URL;
  delete process.env.NEXT_PUBLIC_V3_BASE_VAULT_KERNEL;
  delete process.env.NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB;

  {
    const { v3Deployed, strategiesSupported, requireStrategySupport } = await freshConfig();

    assert.equal(v3Deployed(SEPOLIA), true, "fixture drift: Sepolia should read as v3-deployed here");
    assert.equal(
      strategiesSupported(SEPOLIA),
      false,
      "strategies must be refused on a chain running the v3 kernel",
    );
    assert.throws(
      () => requireStrategySupport(SEPOLIA),
      /not available on this network/,
      "requireStrategySupport must throw on a v3 chain — a silent pass costs the arming fee + a split tx",
    );

    // ---- v3 NOT configured => strategies still work (Base today) -----------------------------
    assert.equal(v3Deployed(BASE), false, "fixture drift: Base should read as v2-only here");
    assert.equal(
      strategiesSupported(BASE),
      true,
      "the guard must not disable strategies on the v2 chains they actually work on",
    );
    assert.doesNotThrow(
      () => requireStrategySupport(BASE),
      "requireStrategySupport must be a no-op on a v2 chain",
    );
  }

  // ---- the LEGACY v2 internals must refuse a v3 chain regardless of how it is configured ------
  // strategiesSupported() now allows a fully-wired v3 chain, so the v2-only split/deposit paths
  // need their own guard: on a v3 chain they would split a v2 note against the v1 entrypoint,
  // i.e. arm against a vault where the user holds nothing.
  {
    const { v2StrategyPathSupported, requireV2StrategyPath } = await freshConfig();
    assert.equal(v2StrategyPathSupported(SEPOLIA), false, "Sepolia runs v3 — the v2 path is invalid");
    assert.throws(
      () => requireV2StrategyPath(SEPOLIA),
      /v2 arming path cannot be used here/,
      "the v2 split/deposit internals must never run on a v3 chain",
    );
    assert.doesNotThrow(
      () => requireV2StrategyPath(BASE),
      "the v2 path is still the right one on a chain without the v3 kernel",
    );
  }

  // ---- the guard tracks config, it is not hardcoded per chain --------------------------------
  // A chain may arm either through the legacy v2 path or through a fully-wired v3 path. A
  // half-configured v3 chain must match neither branch.
  {
    const { strategiesSupported, v2StrategyPathSupported, v3StrategiesLive } = await freshConfig();
    for (const chainId of [SEPOLIA, BASE, 84532, 1]) {
      assert.equal(
        strategiesSupported(chainId),
        v2StrategyPathSupported(chainId) || v3StrategiesLive(chainId),
        `strategiesSupported(${chainId}) must follow the available v2/v3 route — not a chain list`,
      );
    }
  }

  console.log("strategyGuard.check: OK — v2 chains arm, half-configured v3 refused, v2 internals refuse v3");
}

main().catch((e) => {
  console.error("strategyGuard.check FAILED:", e.message);
  process.exit(1);
});
