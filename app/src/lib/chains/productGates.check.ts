//   npx tsx src/lib/chains/productGates.check.ts
import assert from "node:assert";
import { CHAINS, isSolanaRuntime, SOLANA_DEVNET_CHAIN_ID } from "./registry";
import {
  assertSolanaDevnetNativeVault,
  assertSolanaModeTargetsEvmVault,
  ARBITRUM_VAULT_CHAIN_ID,
  forbidsEvmVaultCalls,
  isDevnetProduct,
  productChainById,
  targetsEvmVaultCustody,
  vaultCustodyChainId,
} from "./productGates";

assert.equal(isSolanaRuntime(CHAINS["solana-devnet"]), true);
assert.equal(isSolanaRuntime(CHAINS.base), false);
assert.equal(isDevnetProduct(CHAINS["solana-devnet"]), true);
assert.equal(isDevnetProduct(CHAINS["solana-mainnet"]), false);

assert.equal(forbidsEvmVaultCalls(productChainById("solana-devnet")), true);
assert.equal(forbidsEvmVaultCalls(productChainById("solana-mainnet")), false);
assert.equal(forbidsEvmVaultCalls(productChainById("base")), false);

assert.equal(vaultCustodyChainId(CHAINS["solana-devnet"]), SOLANA_DEVNET_CHAIN_ID);
assert.equal(vaultCustodyChainId(CHAINS["solana-mainnet"]), ARBITRUM_VAULT_CHAIN_ID);
assert.equal(vaultCustodyChainId(CHAINS.base), 8453);
assert.equal(vaultCustodyChainId(CHAINS.sepolia), 11155111);
assert.equal(vaultCustodyChainId(CHAINS.arbitrum), 42161);
assert.equal(vaultCustodyChainId(CHAINS["tempo-moderato"]), 42431);

assert.equal(targetsEvmVaultCustody(CHAINS["solana-devnet"]), false);
assert.equal(targetsEvmVaultCustody(CHAINS["solana-mainnet"]), true);
assert.equal(targetsEvmVaultCustody(CHAINS.base), true);
assert.equal(targetsEvmVaultCustody(CHAINS.arbitrum), true);

assertSolanaModeTargetsEvmVault(CHAINS["solana-mainnet"]);
assertSolanaDevnetNativeVault(CHAINS["solana-devnet"]);
assert.throws(() => assertSolanaModeTargetsEvmVault(CHAINS["solana-devnet"]), /solana-mainnet/);
assert.throws(() => assertSolanaModeTargetsEvmVault(CHAINS.base), /solana-mainnet/);

console.log("productGates.check: PASS (Devnet native + mainnet Arb wrapper)");
