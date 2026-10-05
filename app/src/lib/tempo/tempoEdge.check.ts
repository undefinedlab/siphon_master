/**
 * Tempo ramp + DEX + Zones catalog (and live DEX quote when RPC allows).
 *   npx tsx src/lib/tempo/tempoEdge.check.ts
 */
import assert from "node:assert";
import { ethers } from "ethers";
import { bridgeDest, bridgeDestOptionLabel, tempoWithdrawDisclaimer } from "../bridge/hub";
import { resolveHomeChainOption } from "../chains/homeChains";
import { quoteTempoDexSwap } from "./dex";
import {
  TEMPO_MAINNET_ID,
  TEMPO_MODERATO_ID,
  TEMPO_STABLECOIN_DEX,
  TEMPO_STABLES,
  tempoStables,
} from "./tokens";
import { TEMPO_ZONE_PRODUCT_NOTE, TEMPO_ZONE_SANDBOX, zoneById } from "./zones";

const tempo = bridgeDest(4217)!;
assert.equal(bridgeDestOptionLabel(tempo), "Tempo (as USDC.e)");
assert.ok(tempoWithdrawDisclaimer(tempo)?.includes("Stables only"));

// Connect home is Tempo Moderato testnet; mainnet Tempo remains a LI.FI withdraw/fund edge only.
const home = resolveHomeChainOption("tempo-moderato");
assert.equal(home?.label, "Tempo");
assert.equal(home?.tag, "Testnet");
assert.equal(home?.numericId, 42431);
assert.deepEqual(home?.features, ["On/Off Ramp"]);
assert.equal(resolveHomeChainOption("tempo")?.id, "tempo-moderato");

assert.equal(TEMPO_STABLECOIN_DEX.toLowerCase(), "0xdec0000000000000000000000000000000000000");
assert.ok(TEMPO_STABLES.length >= 4);
assert.ok(!TEMPO_STABLES.some((t) => /eth|sol|wbtc/i.test(t.symbol)));
// Moderato's demo stables are not mainnet predeploys — the mainnet DEX must not offer them.
const mainnetSyms = tempoStables(TEMPO_MAINNET_ID).map((t) => t.symbol);
assert.deepEqual(mainnetSyms, ["pathUSD", "USDC.e", "OUSD"]);
assert.ok(!tempoStables(TEMPO_MODERATO_ID).some((t) => t.symbol === "USDC.e"));

assert.equal(TEMPO_ZONE_SANDBOX.length, 2);
assert.ok(zoneById(6)?.portal);
assert.ok(TEMPO_ZONE_PRODUCT_NOTE.includes("Base"));

console.log("tempoEdge.check: catalog OK");

/** Every pair the swap panel offers must quote — a listed pair with no route is a dead option. */
async function dexQuoteEveryPair() {
  const stables = tempoStables(TEMPO_MAINNET_ID);
  const amountIn = ethers.parseUnits("5", 6);
  for (const a of stables) {
    for (const b of stables) {
      if (a === b) continue;
      const q = await quoteTempoDexSwap({ tokenIn: a.address, tokenOut: b.address, amountIn, chainId: TEMPO_MAINNET_ID });
      assert.ok(q.amountOut > ethers.parseUnits("4.9", 6), `${a.symbol}→${b.symbol} quoted ${q.amountOut}`);
      console.log(`tempoEdge.check: DEX 5 ${a.symbol} → ${ethers.formatUnits(q.amountOut, 6)} ${b.symbol}`);
    }
  }
  const alpha = TEMPO_STABLES.find((t) => t.symbol === "alphaUSD")!;
  await assert.rejects(
    quoteTempoDexSwap({ tokenIn: alpha.address, tokenOut: stables[0].address, amountIn, chainId: TEMPO_MAINNET_ID }),
    /exist on this Tempo network/,
  );
}

dexQuoteEveryPair()
  .then(() => console.log("tempoEdge.check: PASS"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
