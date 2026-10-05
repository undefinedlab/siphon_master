/**
 * Inventory Wormhole Testnet chains + Token Bridge readiness.
 *   npx tsx src/lib/bridge/wormholeTestnetInventory.check.ts
 */
import { wormhole } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import solana from "@wormhole-foundation/sdk/solana";

type ChainCfg = {
  key?: string;
  platform?: string;
  network?: string;
  chainId?: number;
  nativeChainId?: string | number;
  rpc?: string;
  contracts?: {
    coreBridge?: string;
    tokenBridge?: string;
    tokenBridgeRelayer?: string;
    circle?: unknown;
  };
};

async function main() {
  const wh = await wormhole("Testnet", [solana, evm]);
  const entries = Object.entries(wh.config.chains as Record<string, ChainCfg>).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  const rows = entries.map(([name, cfg]) => {
    const tb = Boolean(cfg.contracts?.tokenBridge);
    const core = Boolean(cfg.contracts?.coreBridge);
    const relayer = Boolean(cfg.contracts?.tokenBridgeRelayer);
    return {
      name,
      platform: cfg.platform ?? "?",
      whId: cfg.chainId ?? null,
      nativeId: cfg.nativeChainId != null ? String(cfg.nativeChainId) : null,
      core,
      tokenBridge: tb,
      tbRelayer: relayer,
    };
  });

  const withTb = rows.filter((r) => r.tokenBridge);
  const coreOnly = rows.filter((r) => r.core && !r.tokenBridge);
  const neither = rows.filter((r) => !r.core && !r.tokenBridge);

  const interesting = /hyper|arbitrum|robin|tempo|sepolia|solana|base|optimism|monad|mega|plasma|0g|plume|ink|world|sei|scroll|blast|polygon|avalanche|fuji|holesky|mezo|fogo|nexus|tron|arc|credit|converge|unichain|berachain|linea|moonbeam|celo|kaia|aptos|sui|injective/i;

  console.log("=== Wormhole Testnet — Token Bridge READY (can WTT) ===");
  for (const r of withTb) {
    console.log(
      `  ${r.name.padEnd(22)} wh=${String(r.whId).padEnd(6)} native=${String(r.nativeId).padEnd(12)} relayer=${r.tbRelayer ? "yes" : "no"}`,
    );
  }

  console.log("\n=== Core only (no Token Bridge yet) — interesting names ===");
  for (const r of coreOnly.filter((x) => interesting.test(x.name))) {
    console.log(
      `  ${r.name.padEnd(22)} wh=${String(r.whId).padEnd(6)} native=${String(r.nativeId).padEnd(12)}`,
    );
  }

  console.log("\n=== Siphon-relevant snapshot ===");
  for (const name of [
    "Solana",
    "Sepolia",
    "BaseSepolia",
    "ArbitrumSepolia",
    "OptimismSepolia",
    "PolygonSepolia",
    "HyperEVM",
    "HyperCore",
    "Tempo",
    "RobinhoodChain",
    "Mezo",
    "Monad",
    "Avalanche",
  ]) {
    const r = rows.find((x) => x.name === name);
    if (!r) {
      console.log(`  ${name}: NOT in SDK Testnet config`);
      continue;
    }
    console.log(
      `  ${name}: TB=${r.tokenBridge ? "YES" : "no"} Core=${r.core ? "yes" : "no"} native=${r.nativeId} wh=${r.whId}`,
    );
  }

  console.log(`\nTotals: ${rows.length} chains, ${withTb.length} with Token Bridge, ${coreOnly.length} core-only, ${neither.length} neither`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
