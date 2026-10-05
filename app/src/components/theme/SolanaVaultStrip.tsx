"use client";

import { useChainMode } from "@/lib/chains/ChainModeContext";
import { BASE_VAULT_CHAIN_ID } from "@/lib/chains/productGates";
import { describeSolanaFrontDoor } from "@/lib/chains/solanaVault";

/**
 * Solana front-door strip — Phantom chrome with Base vault custody.
 * Native solana-v1 vault PDA display is parked.
 */
export default function SolanaVaultStrip() {
  const { isSolana, chain, solanaSession } = useChainMode();
  if (!isSolana) return null;

  const desc = describeSolanaFrontDoor({
    profileId: "solana-v1-wrapper",
    custodyProfileId: "evm-v1",
    custodyChainId: BASE_VAULT_CHAIN_ID,
    chainNumericId: chain.numericId,
  });

  return (
    <div
      className="solana-vault-strip"
      style={{
        padding: "0.5rem 1rem",
        fontSize: "0.8rem",
        opacity: 0.85,
        borderBottom: "1px solid color-mix(in srgb, currentColor 12%, transparent)",
      }}
      data-runtime="solana-wrapper"
      data-custody-chain={BASE_VAULT_CHAIN_ID}
    >
      <strong>{chain.label}</strong>
      {" · "}
      {desc}
      {" · vault on Base"}
      {solanaSession ? (
        <>
          {" · "}
          <span title={solanaSession.address}>
            {solanaSession.address.slice(0, 4)}…{solanaSession.address.slice(-4)}
          </span>
        </>
      ) : (
        " · Connect Phantom to fund Base"
      )}
    </div>
  );
}
