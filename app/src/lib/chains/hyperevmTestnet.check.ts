/**
 * HyperEVM Testnet admin-native-vault wiring + live RPC smoke.
 *   npx tsx src/lib/chains/hyperevmTestnet.check.ts
 */
import assert from "node:assert";
import { CHAINS } from "./registry";
import { resolveHomeChainOption } from "./homeChains";
import { chainLogoIdForHomeChainId } from "./chainLogos";
import { vaultCustodyChainId } from "./productGates";
import {
  ADMIN_ONLY_CHAIN_IDS,
  NETWORKS,
  SUPPORTED_CHAIN_IDS,
  getTokens,
} from "../networks";
import { v3Config } from "../v3/configV3";

const HYPEREVM_TESTNET = 998;
const USDC = "0x2B3370eE501B4a559b57D449569354196457D8Ab";

assert.ok(SUPPORTED_CHAIN_IDS.includes(HYPEREVM_TESTNET));
assert.ok(ADMIN_ONLY_CHAIN_IDS.includes(HYPEREVM_TESTNET));
assert.equal(CHAINS["hyperevm-testnet"].numericId, HYPEREVM_TESTNET);
assert.equal(vaultCustodyChainId(CHAINS["hyperevm-testnet"]), HYPEREVM_TESTNET);

const home = resolveHomeChainOption("hyperevm-testnet");
assert.ok(home);
assert.equal(home.label, "Hyperliquid");
assert.equal(home.tag, "Testnet");
assert.equal(home.adminOnly, true);
assert.equal(home.numericId, HYPEREVM_TESTNET);
assert.equal(home.productChainId, "hyperevm-testnet");
assert.equal(home.edgeChainId, undefined); // native vault home, not Base-bridged
assert.equal(chainLogoIdForHomeChainId("hyperevm-testnet"), "hyperliquid");

const n = NETWORKS[HYPEREVM_TESTNET];
assert.equal(n.usdc.toLowerCase(), USDC.toLowerCase());
assert.equal(n.rpcUrl, "https://rpc.hyperliquid-testnet.xyz/evm");
assert.equal(n.nativeCurrency.symbol, "HYPE");

const tokens = getTokens(HYPEREVM_TESTNET);
assert.equal(tokens.USDC.address.toLowerCase(), USDC.toLowerCase());
assert.equal(tokens.HYPE.symbol, "HYPE");
assert.ok(!tokens.ETH, "HyperEVM Testnet has no ETH token in the vault UI");

assert.equal(v3Config(HYPEREVM_TESTNET)?.chainId, HYPEREVM_TESTNET);
assert.equal(v3Config(HYPEREVM_TESTNET)?.vaultKernel, "0x0000000000000000000000000000000000000000");

console.log("hyperevmTestnet.check: catalog OK");

async function rpcSmoke() {
  const res = await fetch(n.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!res.ok || body.error) throw new Error(body.error?.message || `HTTP ${res.status}`);
  const id = parseInt(body.result || "0", 16);
  assert.equal(id, HYPEREVM_TESTNET, `expected chain ${HYPEREVM_TESTNET}, got ${id}`);
  console.log(`hyperevmTestnet.check: RPC OK — chainId ${id}`);
}

rpcSmoke()
  .then(() => console.log("hyperevmTestnet.check: PASS"))
  .catch((e) => {
    console.error("hyperevmTestnet.check: RPC FAIL", e);
    process.exit(1);
  });
