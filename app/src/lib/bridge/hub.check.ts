// Runnable self-check: withdraw-to-any-chain catalog, address validation and the min_out bound.
//   npx tsx src/lib/bridge/hub.check.ts
import assert from "node:assert";
import {
  BRIDGE_DESTS,
  BRIDGE_VAULT_CHAIN_IDS,
  FUND_SOURCES,
  HUB_CHAIN_ID,
  SOLANA_LIFI_ID,
  ZCASH_LIFI_ID,
  bridgeDest,
  bridgeDestDisclaimer,
  bridgeDestOptionLabel,
  bridgeDestsFrom,
  bridgeMinUnits,
  bridgeStatusText,
  fundSourceForEdge,
  fundSourcesInto,
  isBridgeVaultChain,
  isValidDestAddress,
  minOutFrom,
  payoutDestFor,
  tempoWithdrawDisclaimer,
  vaultUsdc,
  withdrawNodeTitle,
  zcashWithdrawDisclaimer,
} from "./hub";
import {
  HYPERLIQUID_EDGE_CHAIN_ID,
  SOLANA_EDGE_CHAIN_ID,
  resolveHomeChainOption,
} from "../chains/homeChains";

// min_out = floor(toAmountMin * 98 / 100), in the destination token's units.
assert.equal(minOutFrom("1000000"), "980000");
assert.equal(minOutFrom("999"), "979"); // 979.02 floors
assert.equal(minOutFrom("123456789012345678901"), "120987653232098765322"); // ZEC-scale, no float loss
assert.equal(minOutFrom("0"), "0");

// Catalog includes every payout chain (Base + Arb are vault hubs that can also be destinations).
assert.deepEqual(
  BRIDGE_DESTS.map((d) => d.id).sort((a, b) => a - b),
  [8453, 1, 999, 1337, 4217, 42161, ZCASH_LIFI_ID, SOLANA_LIFI_ID].sort((a, b) => a - b),
);
assert.deepEqual([...BRIDGE_VAULT_CHAIN_IDS].sort((a, b) => a - b), [8453, 42161]);
assert.ok(isBridgeVaultChain(HUB_CHAIN_ID));
assert.ok(isBridgeVaultChain(42161));
assert.ok(!isBridgeVaultChain(1));
assert.ok(!isBridgeVaultChain(4217));
assert.equal(bridgeDest(8453)?.label, "Base");
assert.equal(bridgeDest(SOLANA_LIFI_ID)?.kind, "solana");
assert.equal(bridgeDest(ZCASH_LIFI_ID)?.toToken, "ZEC");
assert.equal(bridgeDestOptionLabel(bridgeDest(ZCASH_LIFI_ID)!), "Zcash (as ZEC)");
assert.equal(bridgeDestOptionLabel(bridgeDest(42161)!), "Arbitrum");
assert.equal(bridgeDestOptionLabel(bridgeDest(4217)!), "Tempo (as USDC.e)");
assert.ok(zcashWithdrawDisclaimer(bridgeDest(ZCASH_LIFI_ID)!)?.includes("ZEC"));
assert.equal(zcashWithdrawDisclaimer(bridgeDest(42161)!), null);
assert.ok(tempoWithdrawDisclaimer(bridgeDest(4217)!)?.includes("USDC.e"));
assert.ok(bridgeDestDisclaimer(bridgeDest(4217)!)?.toLowerCase().includes("stables"));
assert.equal(withdrawNodeTitle("Zcash"), "Withdraw to Zcash (as ZEC)");
assert.equal(withdrawNodeTitle("Base"), "Withdraw to Base");

// From Base: every dest except Base. From Arb: every dest except Arb (incl. Base, Eth, Sol, Tempo…).
assert.ok(!bridgeDestsFrom(8453).some((d) => d.id === 8453));
assert.ok(bridgeDestsFrom(8453).some((d) => d.id === 42161));
assert.ok(bridgeDestsFrom(8453).some((d) => d.id === 1));
assert.ok(bridgeDestsFrom(8453).some((d) => d.id === SOLANA_LIFI_ID));
assert.ok(bridgeDestsFrom(8453).some((d) => d.id === 4217));
assert.ok(!bridgeDestsFrom(42161).some((d) => d.id === 42161));
assert.ok(bridgeDestsFrom(42161).some((d) => d.id === 8453));
assert.ok(bridgeDestsFrom(42161).some((d) => d.id === 1));
assert.ok(bridgeDestsFrom(42161).some((d) => d.id === SOLANA_LIFI_ID));
assert.equal(payoutDestFor(8453, "Base"), null);
assert.equal(payoutDestFor(8453, "Ethereum")?.id, 1);
assert.equal(payoutDestFor(8453, "Solana")?.id, SOLANA_LIFI_ID);
assert.equal(payoutDestFor(8453, "Tempo")?.id, 4217);
assert.equal(payoutDestFor(42161, "Arbitrum"), null);
assert.equal(payoutDestFor(42161, "Base")?.id, 8453);
assert.equal(payoutDestFor(42161, "Ethereum")?.id, 1);
assert.equal(payoutDestFor(1, "Ethereum"), null); // not a vault hub

// Fund sources into each vault exclude the vault itself; Base↔Arb both fund each other.
assert.ok(FUND_SOURCES.some((s) => s.id === 8453));
assert.ok(FUND_SOURCES.some((s) => s.id === 1));
assert.ok(FUND_SOURCES.some((s) => s.id === SOLANA_LIFI_ID));
assert.ok(FUND_SOURCES.some((s) => s.id === 4217));
assert.ok(!fundSourcesInto(8453).some((s) => s.id === 8453));
assert.ok(fundSourcesInto(8453).some((s) => s.id === 42161));
assert.ok(fundSourcesInto(8453).some((s) => s.id === 1));
assert.ok(!fundSourcesInto(42161).some((s) => s.id === 42161));
assert.ok(fundSourcesInto(42161).some((s) => s.id === 8453));
assert.equal(vaultUsdc(8453).toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
assert.equal(vaultUsdc(42161).toLowerCase(), "0xaf88d065e77c8cc2239327c5edb3a432268e5831");

// HyperCore and Zcash cannot fund; their homes fall back to a chain that can.
assert.ok(!FUND_SOURCES.some((s) => s.id === 1337 || s.id === ZCASH_LIFI_ID));
assert.equal(fundSourceForEdge(1337), 999);
assert.equal(fundSourceForEdge(ZCASH_LIFI_ID), 42161);
assert.equal(fundSourceForEdge(4217), 4217);
assert.equal(fundSourceForEdge(null), 42161);

const EVM = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
assert.ok(isValidDestAddress("evm", EVM));
assert.ok(isValidDestAddress("evm", ` ${EVM} `), "surrounding whitespace is trimmed");
assert.ok(!isValidDestAddress("evm", EVM.slice(0, 41)));
assert.ok(!isValidDestAddress("evm", SOL));
assert.ok(isValidDestAddress("solana", SOL));
assert.ok(!isValidDestAddress("solana", EVM));
assert.ok(!isValidDestAddress("solana", "0OIl" + SOL.slice(4)), "non-base58 characters");
assert.ok(!isValidDestAddress("solana", SOL.slice(0, 20)), "decodes to fewer than 32 bytes");
assert.ok(isValidDestAddress("zcash", "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs"));
assert.ok(isValidDestAddress("zcash", "t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd"));
assert.ok(isValidDestAddress("zcash", "u1" + "q".repeat(70)));
assert.ok(!isValidDestAddress("zcash", "zs1" + "q".repeat(75)), "sapling-only is not accepted");
assert.ok(!isValidDestAddress("zcash", EVM));

assert.equal(bridgeStatusText({ status: "REVIEW", error: null }), "An operator is checking this transfer");
assert.equal(bridgeStatusText({ status: "FAILED", error: "spend reverted" }), "Failed: spend reverted");

console.log("hub.check: OK — catalog, address validation, min_out");

// homeChains duplicates the Solana id to keep @solana/web3.js out of the picker bundle.
assert.equal(SOLANA_EDGE_CHAIN_ID, SOLANA_LIFI_ID);
assert.equal(fundSourceForEdge(SOLANA_EDGE_CHAIN_ID), SOLANA_LIFI_ID); // funds from Phantom by default

// Mainnet Solana home = Base vault owned by the EVM wallet, Phantom on the Solana edge.
const solHome = resolveHomeChainOption("solana-mainnet");
assert.equal(solHome?.kind, "evm");
assert.equal(solHome?.numericId, 8453);
assert.equal(solHome?.edgeChainId, SOLANA_LIFI_ID);

// Tempo / Hyperliquid: LI.FI edges still fund; connect homes are testnet-only.
assert.equal(fundSourceForEdge(4217), 4217);
assert.equal(fundSourceForEdge(HYPERLIQUID_EDGE_CHAIN_ID), 999);

// Legacy mainnet Tempo / Hyperliquid home ids resolve to their testnet cards.
const tempoLegacy = resolveHomeChainOption("tempo");
assert.equal(tempoLegacy?.id, "tempo-moderato");
assert.equal(tempoLegacy?.tag, "Testnet");
const hlLegacy = resolveHomeChainOption("hyperliquid");
assert.equal(hlLegacy?.id, "hyperevm-testnet");
assert.equal(hlLegacy?.tag, "Testnet");

// Legacy "ethereum" home id resolves to Base (L1 bridged home removed from picker).
const ethLegacy = resolveHomeChainOption("ethereum");
assert.equal(ethLegacy?.id, "base");
assert.equal(fundSourceForEdge(1), 1);

// ETH testnet home = Sepolia vault (labeled ETH in the picker).
const ethTestnet = resolveHomeChainOption("sepolia");
assert.equal(ethTestnet?.label, "ETH");
assert.equal(ethTestnet?.tag, "Testnet");
assert.equal(ethTestnet?.numericId, 11155111);

// Per-destination floor: Zcash has no route under ~8 USDC; everyone else keeps the 1 USDC floor.
assert.equal(bridgeMinUnits(bridgeDest(ZCASH_LIFI_ID)!), 10_000_000n);
assert.equal(bridgeMinUnits(bridgeDest(42161)!), 1_000_000n);
assert.equal(bridgeMinUnits(bridgeDest(1337)!), 1_000_000n);
assert.equal(bridgeMinUnits(bridgeDest(8453)!), 1_000_000n);
