/**
 * Devnet Solana USDC → Sepolia test-USDC mint client.
 */
import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";

export type DevnetUsdcBridgeResult = {
  ok?: boolean;
  pending?: boolean;
  message?: string;
  mintTx?: string;
  usdcToken?: string;
  amount?: number | string;
  error?: string;
  clientAction?: string;
};

function executorBase(): string {
  try {
    return getTradeExecutorBaseUrl().replace(/\/$/, "");
  } catch {
    return (process.env.NEXT_PUBLIC_TRADE_EXECUTOR_URL || "").replace(/\/$/, "");
  }
}

/** Human USDC → base units (6 decimals). */
export function usdcToBaseUnitsDevnet(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("Enter a valid USDC amount.");
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "0".repeat(6)).slice(0, 6);
  return BigInt(whole + padded);
}

/**
 * Mint Sepolia test USDC for a Devnet Solana USDC deposit, then caller runs depositV3.
 */
export async function bridgeUsdcDevnetToSepolia(params: {
  amountBaseUnits: bigint;
  solanaOwner: string;
  recipient: string;
}): Promise<DevnetUsdcBridgeResult> {
  const base = executorBase();
  if (!base) throw new Error("Set NEXT_PUBLIC_TRADE_EXECUTOR_URL for the Devnet bridge.");
  const response = await fetch(`${base}/solana/devnetBridge/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: params.amountBaseUnits.toString(),
      solana_owner: params.solanaOwner,
      recipient: params.recipient,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as DevnetUsdcBridgeResult;
  if (!response.ok) {
    throw new Error(body.error || body.message || "Devnet USDC bridge failed.");
  }
  if (!body.ok) {
    throw new Error(body.message || "Devnet bridge did not mint test USDC.");
  }
  return body;
}
