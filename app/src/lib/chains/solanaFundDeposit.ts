/**
 * Solana product deposit prelude.
 * Mainnet = Li.Fi → Arbitrum then depositV3.
 * Devnet = native Solana vault (see depositUsdcSolanaDevnet) — not this helper.
 */
import {
  ARBITRUM_VAULT_CHAIN_ID,
  planSolUsdcToEvm,
  usdcToBaseUnits,
} from "@/lib/chains/mainnetSolBridge";
import { isDevnetProduct } from "@/lib/chains/productGates";
import type { SiphonChain } from "@/lib/chains/registry";
import { SOLANA_DEVNET_CHAIN_ID } from "@/lib/chains/registry";
import { selectChainAndSwitchWallet } from "@/lib/networks";

export type SolanaFundPreludeResult =
  | { kind: "ready"; custodyChainId: number; message?: string }
  | { kind: "bridge_pending"; custodyChainId: number; toolUrl?: string; message: string }
  | { kind: "native_solana"; custodyChainId: typeof SOLANA_DEVNET_CHAIN_ID; message: string };

export function solanaDepositCustodyChainId(chain: SiphonChain): number {
  return isDevnetProduct(chain) ? SOLANA_DEVNET_CHAIN_ID : ARBITRUM_VAULT_CHAIN_ID;
}

/**
 * Mainnet: ensure Arbitrum custody + Li.Fi plan when EVM USDC is short.
 * Devnet: signals native Solana path (caller must use depositUsdcSolanaDevnet).
 */
export async function prepareSolanaFundForDeposit(params: {
  chain: SiphonChain;
  amount: string;
  solanaOwner: string;
  recipient: string;
  /** When true, skip public bridge and only switch to custody (wallet already holds USDC). */
  evmAlreadyFunded?: boolean;
}): Promise<SolanaFundPreludeResult> {
  if (isDevnetProduct(params.chain)) {
    return {
      kind: "native_solana",
      custodyChainId: SOLANA_DEVNET_CHAIN_ID,
      message: "Devnet deposits into the Siphon Solana vault (Phantom signs Deposit).",
    };
  }

  const custodyChainId = ARBITRUM_VAULT_CHAIN_ID;
  await selectChainAndSwitchWallet(custodyChainId, params.recipient);

  if (params.evmAlreadyFunded) {
    return { kind: "ready", custodyChainId, message: "Using USDC already on Arbitrum." };
  }

  const amountBase = usdcToBaseUnits(params.amount);
  if (amountBase <= 0n) throw new Error("Enter a valid USDC amount.");

  const plan = await planSolUsdcToEvm({
    amountBaseUnits: amountBase,
    solanaOwner: params.solanaOwner,
    recipient: params.recipient,
    toChainId: ARBITRUM_VAULT_CHAIN_ID,
  });
  const bridge = plan.stepStatus?.find((s) => s.step === "public_bridge_hop");
  const toolUrl = bridge?.toolUrl;
  if (toolUrl && typeof window !== "undefined") {
    window.open(toolUrl, "_blank", "noopener,noreferrer");
  }
  return {
    kind: "bridge_pending",
    custodyChainId,
    toolUrl,
    message:
      plan.message ||
      "Complete the Phantom → Arbitrum USDC bridge, then click Deposit again to vault.",
  };
}
