/**
 * Tempo Moderato is the Tempo testnet home (admin) for DEX/Zone prototypes.
 *   npx tsx src/lib/chains/tempoModerato.check.ts
 */
import assert from "node:assert";
import { CHAINS } from "./registry";
import { listHomeChainOptions, resolveHomeChainOption } from "./homeChains";
import { vaultCustodyChainId } from "./productGates";
import {
  ADMIN_ONLY_CHAIN_IDS,
  NETWORKS,
  SUPPORTED_CHAIN_IDS,
  getTokens,
} from "../networks";
import { v3Config } from "../v3/configV3";

const MODERATO = 42431;
const PATHUSD = "0x20c0000000000000000000000000000000000000";

assert.ok(SUPPORTED_CHAIN_IDS.includes(MODERATO));
assert.ok(ADMIN_ONLY_CHAIN_IDS.includes(MODERATO));
assert.equal(CHAINS["tempo-moderato"].numericId, MODERATO);
assert.equal(vaultCustodyChainId(CHAINS["tempo-moderato"]), MODERATO);

// Product: Tempo testnet home (Moderato) + mainnet Tempo ramp on Base.
const home = resolveHomeChainOption("tempo-moderato");
assert.ok(home);
assert.equal(home.label, "Tempo");
assert.equal(home.tag, "Testnet");
assert.equal(home.adminOnly, true);
assert.equal(home.numericId, MODERATO);
assert.ok(listHomeChainOptions().some((o) => o.id === "tempo-moderato"));
// No mainnet Tempo connect card — only the Moderato testnet home.
assert.ok(!listHomeChainOptions().some((o) => o.id === "tempo"));

const n = NETWORKS[MODERATO];
assert.equal(n.usdc.toLowerCase(), PATHUSD);
assert.equal(n.swapRouter.toLowerCase(), "0xdec0000000000000000000000000000000000000");

const tokens = getTokens(MODERATO);
assert.equal(tokens.USDC.address.toLowerCase(), PATHUSD);
assert.ok(!tokens.ETH, "Moderato has no ETH in the vault UI");

assert.equal(v3Config(MODERATO)?.chainId, MODERATO);
assert.equal(v3Config(MODERATO)?.vaultKernel, "0x0000000000000000000000000000000000000000");

console.log("tempoModerato.check: PASS (Tempo testnet home + scaffolding)");
