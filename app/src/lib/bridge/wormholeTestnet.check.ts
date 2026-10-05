/**
 * Catalog self-check for Wormhole Testnet routes (no live keys).
 *   npx tsx src/lib/bridge/wormholeTestnet.check.ts
 */
import assert from "node:assert";
import { wormhole } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import solana from "@wormhole-foundation/sdk/solana";
import {
  WORMHOLE_ARB_SEPOLIA_CHAIN_ID,
  WORMHOLE_BASE_SEPOLIA_CHAIN_ID,
  WORMHOLE_HYPEREVM_TESTNET_CHAIN_ID,
  WORMHOLE_SEPOLIA_CHAIN_ID,
  WORMHOLE_SOL_DEVNET_UI_ID,
  WORMHOLE_TEMPO_MODERATO_CHAIN_ID,
  WORMHOLE_TEMPO_ROUTES_PLANNED,
  WORMHOLE_TEMPO_TOKEN_BRIDGE_READY,
  WORMHOLE_TESTNET_ROUTES,
  preferWormholeTestnetBridge,
  wormholeChainForSiphonId,
  wormholeTestnetRoute,
  wormholeTestnetScanUrl,
  wormholeTokenBridgeReady,
} from "./wormholeTestnet";

assert.ok(WORMHOLE_TESTNET_ROUTES.length >= 8);
assert.ok(wormholeTestnetRoute("sol-devnet→sepolia"));
assert.ok(wormholeTestnetRoute("sol-devnet→arb-sepolia"));
assert.ok(wormholeTestnetRoute("arb-sepolia→sol-devnet"));
assert.ok(wormholeTestnetRoute("sol-devnet→hyperevm"));
assert.ok(wormholeTestnetRoute("hyperevm→sol-devnet"));
assert.ok(wormholeTestnetRoute("sepolia→arb-sepolia"));
assert.equal(wormholeTestnetRoute("sol-devnet→arb-sepolia")?.mode, "TokenBridge");
assert.equal(wormholeTestnetRoute("sol-devnet→hyperevm")?.mode, "TokenBridge");
assert.equal(wormholeTestnetRoute("sepolia→arb-sepolia")?.mode, "AutomaticTokenBridge");

assert.equal(wormholeChainForSiphonId(WORMHOLE_SOL_DEVNET_UI_ID), "Solana");
assert.equal(wormholeChainForSiphonId(WORMHOLE_SEPOLIA_CHAIN_ID), "Sepolia");
assert.equal(wormholeChainForSiphonId(WORMHOLE_BASE_SEPOLIA_CHAIN_ID), "BaseSepolia");
assert.equal(wormholeChainForSiphonId(WORMHOLE_ARB_SEPOLIA_CHAIN_ID), "ArbitrumSepolia");
assert.equal(wormholeChainForSiphonId(WORMHOLE_HYPEREVM_TESTNET_CHAIN_ID), "HyperEVM");
assert.equal(wormholeChainForSiphonId(WORMHOLE_TEMPO_MODERATO_CHAIN_ID), "Tempo");
assert.equal(wormholeChainForSiphonId(8453), null);

assert.equal(
  preferWormholeTestnetBridge(WORMHOLE_SOL_DEVNET_UI_ID, WORMHOLE_SEPOLIA_CHAIN_ID),
  true,
);
assert.equal(
  preferWormholeTestnetBridge(WORMHOLE_SOL_DEVNET_UI_ID, WORMHOLE_ARB_SEPOLIA_CHAIN_ID),
  true,
);
assert.equal(
  preferWormholeTestnetBridge(WORMHOLE_ARB_SEPOLIA_CHAIN_ID, WORMHOLE_SOL_DEVNET_UI_ID),
  true,
);
assert.equal(
  preferWormholeTestnetBridge(WORMHOLE_SOL_DEVNET_UI_ID, WORMHOLE_HYPEREVM_TESTNET_CHAIN_ID),
  true,
);
assert.equal(
  preferWormholeTestnetBridge(WORMHOLE_HYPEREVM_TESTNET_CHAIN_ID, WORMHOLE_SOL_DEVNET_UI_ID),
  true,
);
assert.equal(
  preferWormholeTestnetBridge(WORMHOLE_SEPOLIA_CHAIN_ID, WORMHOLE_ARB_SEPOLIA_CHAIN_ID),
  true,
);
assert.equal(preferWormholeTestnetBridge(8453, 42161), false);
assert.equal(
  preferWormholeTestnetBridge(WORMHOLE_SOL_DEVNET_UI_ID, WORMHOLE_TEMPO_MODERATO_CHAIN_ID),
  false,
);

assert.equal(wormholeTokenBridgeReady("Solana"), true);
assert.equal(wormholeTokenBridgeReady("ArbitrumSepolia"), true);
assert.equal(wormholeTokenBridgeReady("HyperEVM"), true);
assert.equal(wormholeTokenBridgeReady("Tempo"), false);
assert.equal(WORMHOLE_TEMPO_TOKEN_BRIDGE_READY, false);
assert.ok(WORMHOLE_TEMPO_ROUTES_PLANNED.length >= 2);

assert.ok(wormholeTestnetScanUrl("abc123").includes("Testnet"));

console.log("wormholeTestnet.check: catalog OK");
console.log(
  "  live routes:",
  WORMHOLE_TESTNET_ROUTES.map((r) => r.id).join(", "),
);

async function assertSdkContracts() {
  const wh = await wormhole("Testnet", [solana, evm]);

  for (const name of ["Solana", "Sepolia", "ArbitrumSepolia", "HyperEVM", "BaseSepolia"] as const) {
    const cfg = wh.config.chains[name] as {
      nativeChainId?: string | number;
      contracts?: { tokenBridge?: string; coreBridge?: string };
    };
    assert.ok(cfg?.contracts?.tokenBridge, `${name} must have Token Bridge in SDK`);
    assert.ok(cfg?.contracts?.coreBridge, `${name} must have Core in SDK`);
    console.log(`  SDK TB OK: ${name} (native=${cfg.nativeChainId})`);
  }

  const tempo = wh.config.chains.Tempo as {
    nativeChainId?: string | number;
    contracts?: { coreBridge?: string; tokenBridge?: string };
  };
  assert.equal(String(tempo.nativeChainId), String(WORMHOLE_TEMPO_MODERATO_CHAIN_ID));
  assert.ok(tempo.contracts?.coreBridge, "Tempo Core bridge expected");
  assert.equal(tempo.contracts?.tokenBridge, undefined, "Token Bridge must still be absent");
  console.log(
    "  Tempo Moderato: Core OK, Token Bridge not deployed — planned:",
    WORMHOLE_TEMPO_ROUTES_PLANNED.map((r) => r.id).join(", "),
  );
}

assertSdkContracts()
  .then(() => console.log("wormholeTestnet.check: PASS"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
