/**
 * Mainnet Solana USDC → Arbitrum fund hop via Li.Fi (plan/quote only).
 */
import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";
import { SOLANA_MAINNET_CHAIN_ID } from "@/lib/chains/registry";

export const ARBITRUM_VAULT_CHAIN_ID = 42161;

/** Mainnet Circle USDC mint — never use Devnet mint env here. */
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type MainnetFundPlan = {
  ok?: boolean;
  pending?: boolean;
  message?: string;
  clientNext?: string;
  toChainId?: number;
  stepStatus?: Array<{
    step: string;
    status: string;
    message?: string;
    quoteAvailable?: boolean;
    toolUrl?: string;
    toAmount?: string;
    tool?: string;
    hasTransactionRequest?: boolean;
  }>;
  error?: string;
};

function executorBase(): string {
  try {
    return getTradeExecutorBaseUrl().replace(/\/$/, "");
  } catch {
    return (process.env.NEXT_PUBLIC_TRADE_EXECUTOR_URL || "").replace(/\/$/, "");
  }
}

/** Human USDC → base units (6 decimals). */
export function usdcToBaseUnits(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("Enter a valid USDC amount.");
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "0".repeat(6)).slice(0, 6);
  return BigInt(whole + padded);
}

export type FundDestChainId = typeof ARBITRUM_VAULT_CHAIN_ID;

/**
 * Ask the executor for a Li.Fi Solana USDC → Arbitrum USDC quote/plan.
 */
export async function planSolUsdcToEvm(params: {
  amountBaseUnits: bigint;
  solanaOwner: string;
  recipient: string;
  toChainId?: FundDestChainId;
}): Promise<MainnetFundPlan> {
  const base = executorBase();
  if (!base) throw new Error("Set NEXT_PUBLIC_TRADE_EXECUTOR_URL for the Li.Fi fund plan.");
  const toChainId = params.toChainId ?? ARBITRUM_VAULT_CHAIN_ID;
  if (toChainId !== ARBITRUM_VAULT_CHAIN_ID) {
    throw new Error("Destination must be Arbitrum (42161).");
  }
  const response = await fetch(`${base}/solana/fundBase/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from_chain_id: SOLANA_MAINNET_CHAIN_ID,
      to_chain_id: toChainId,
      amount: params.amountBaseUnits.toString(),
      asset: "USDC",
      mint: SOLANA_USDC_MINT,
      solana_owner: params.solanaOwner,
      recipient: params.recipient,
      bridge_adapter: "lifi",
    }),
  });
  const body = (await response.json().catch(() => ({}))) as MainnetFundPlan;
  if (!response.ok) {
    throw new Error(body.error || body.message || "Li.Fi fund plan failed.");
  }
  return body;
}

/** @deprecated Use planSolUsdcToEvm */
export async function planSolMainnetToBase(params: {
  lamports: bigint;
  solanaOwner: string;
  recipient: string;
  asset?: "SOL" | "USDC";
}): Promise<MainnetFundPlan> {
  if (params.asset === "SOL") {
    throw new Error("Solana fund door accepts USDC only.");
  }
  return planSolUsdcToEvm({
    amountBaseUnits: params.lamports,
    solanaOwner: params.solanaOwner,
    recipient: params.recipient,
    toChainId: ARBITRUM_VAULT_CHAIN_ID,
  });
}
