/**
 * Solana front-door helpers.
 * Devnet: native solana-v1 vault (BPF MVP). Mainnet: Arbitrum EVM wrapper.
 */

import { ARBITRUM_VAULT_CHAIN_ID } from "@/lib/chains/productGates";
import { SOLANA_DEVNET_CHAIN_ID } from "@/lib/chains/registry";
import { SIPHON_VAULT_PROGRAM_ID, vaultPda } from "@/lib/chains/solanaVaultOnchain";

export type SolanaFrontDoorBinding = {
  profileId: "solana-v1-wrapper" | "solana-v1";
  custodyProfileId: "evm-v1" | "solana-v1";
  custodyChainId: number;
  chainNumericId: number;
  programId?: string;
  vaultPda?: string;
};

export function describeSolanaFrontDoor(binding: SolanaFrontDoorBinding): string {
  const prog = binding.programId ? ` program=${binding.programId.slice(0, 8)}…` : "";
  return `${binding.profileId} · custody ${binding.custodyProfileId}@${binding.custodyChainId}${prog}`;
}

/** Devnet native vault binding. */
export function solanaDevnetNativeBinding(): SolanaFrontDoorBinding {
  const [pda] = vaultPda();
  return {
    profileId: "solana-v1",
    custodyProfileId: "solana-v1",
    custodyChainId: SOLANA_DEVNET_CHAIN_ID,
    chainNumericId: SOLANA_DEVNET_CHAIN_ID,
    programId: SIPHON_VAULT_PROGRAM_ID.toBase58(),
    vaultPda: pda.toBase58(),
  };
}

/** Mainnet wrapper binding (Arbitrum custody). */
export function solanaMainnetWrapperBinding(): SolanaFrontDoorBinding {
  return {
    profileId: "solana-v1-wrapper",
    custodyProfileId: "evm-v1",
    custodyChainId: ARBITRUM_VAULT_CHAIN_ID,
    chainNumericId: 900_001,
  };
}

/** @deprecated Parked native vault binding — prefer solanaDevnetNativeBinding. */
export type SolanaVaultBinding = {
  profileId: "solana-v1";
  verifyArtifactId: "groth16-bn254-solana-altbn128-v1";
  programId: string;
  vaultPda: string;
  chainNumericId: number;
};

/** @deprecated */
export function describeSolanaVault(binding: SolanaVaultBinding): string {
  return describeSolanaFrontDoor({
    profileId: "solana-v1",
    custodyProfileId: "solana-v1",
    custodyChainId: binding.chainNumericId,
    chainNumericId: binding.chainNumericId,
    programId: binding.programId,
    vaultPda: binding.vaultPda,
  });
}

export const DEFAULT_SIPHON_PROGRAM_ID =
  process.env.NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID?.trim() ||
  SIPHON_VAULT_PROGRAM_ID.toBase58();
