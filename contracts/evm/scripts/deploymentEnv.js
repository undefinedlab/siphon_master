"use strict";

/**
 * Chain-specific env aliases for v2 vault deploys.
 * Ported from siphon-contracts/evm/scripts/deploymentEnv.ts (Entrypoint → VaultKernel).
 */

/**
 * @param {number} chainId
 * @param {string} vault
 * @param {number} deployBlock
 * @param {{ ComplianceHub?: string, VerifierRegistry?: string, SpendActionGroth16Router?: string }} [extra]
 * @returns {string[]}
 */
function deploymentEnvLines(chainId, vault, deployBlock, extra = {}) {
  const hub = extra.ComplianceHub ?? "";
  const registry = extra.VerifierRegistry ?? "";
  const router = extra.SpendActionGroth16Router ?? "";

  const common = [
    `VAULT_KERNEL_${chainId}=${vault}`,
    `VAULT_KERNEL_DEPLOY_BLOCK_${chainId}=${deployBlock}`,
    hub && `COMPLIANCE_HUB_${chainId}=${hub}`,
    hub && `ASP_COMPLIANCE_HUB_${chainId}=${hub}`,
    hub && `COMPLIANCE_HUB_ADDRESS=${hub}`,
    registry && `VERIFIER_REGISTRY_${chainId}=${registry}`,
    router && `SPEND_ROUTER_${chainId}=${router}`,
  ].filter(Boolean);

  if (chainId === 8453) {
    return [
      ...common,
      `NEXT_PUBLIC_BASE_MAINNET_VAULT_KERNEL=${vault}`,
      `NEXT_PUBLIC_BASE_MAINNET_VAULT_DEPLOY_BLOCK=${deployBlock}`,
      `BASE_MAINNET_VAULT_KERNEL=${vault}`,
      `VAULT_KERNEL_BASE=${vault}`,
    ];
  }
  if (chainId === 11155111) {
    return [
      ...common,
      `NEXT_PUBLIC_ETH_SEPOLIA_VAULT_KERNEL=${vault}`,
      `NEXT_PUBLIC_ETH_SEPOLIA_VAULT_DEPLOY_BLOCK=${deployBlock}`,
      `ETH_SEPOLIA_VAULT_KERNEL=${vault}`,
      `VAULT_KERNEL_SEPOLIA=${vault}`,
    ];
  }
  if (chainId === 84532) {
    return [
      ...common,
      `BASE_SEPOLIA_VAULT_KERNEL=${vault}`,
      `VAULT_KERNEL_BASE_SEPOLIA=${vault}`,
      `NEXT_PUBLIC_BASE_SEPOLIA_VAULT_KERNEL=${vault}`,
    ];
  }
  if (chainId === 998) {
    return [
      ...common,
      `HYPEREVM_TESTNET_VAULT_KERNEL=${vault}`,
      `VAULT_KERNEL_HYPEREVM_TESTNET=${vault}`,
      `NEXT_PUBLIC_V3_HYPEREVM_TESTNET_VAULT_KERNEL=${vault}`,
      `NEXT_PUBLIC_V3_HYPEREVM_TESTNET_DEPLOY_BLOCK=${deployBlock}`,
      hub && `NEXT_PUBLIC_V3_HYPEREVM_TESTNET_COMPLIANCE_HUB=${hub}`,
      hub && `ASP_COMPLIANCE_HUB_998=${hub}`,
    ].filter(Boolean);
  }
  if (chainId === 42431) {
    return [
      ...common,
      `TEMPO_MODERATO_VAULT_KERNEL=${vault}`,
      `NEXT_PUBLIC_V3_TEMPO_MODERATO_VAULT_KERNEL=${vault}`,
      `NEXT_PUBLIC_V3_TEMPO_MODERATO_DEPLOY_BLOCK=${deployBlock}`,
      hub && `NEXT_PUBLIC_V3_TEMPO_MODERATO_COMPLIANCE_HUB=${hub}`,
    ].filter(Boolean);
  }
  return common;
}

module.exports = { deploymentEnvLines };
