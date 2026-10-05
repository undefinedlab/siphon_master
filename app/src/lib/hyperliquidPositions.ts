/**
 * Fetch / close the Hyperliquid positions the trade executor holds for a user.
 * Lifecycle: FUNDING → OPENING → OPEN → CLOSING → PAYOUT_DUE → PAYING → SETTLED
 * (REFUNDED: the bridge handed the margin back on Base; REVIEW: an operator is checking).
 */
import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";
import { getCachedWalletAuthHeaders, getWalletWriteAuthHeaders } from "@/lib/walletAuthHeaders";
import { getSigner } from "@/lib/nexus";

export interface HyperliquidPosition {
  id: string;
  strategy_id: string;
  user_id: string;
  coin: string;
  side: "LONG" | "SHORT";
  leverage: number;
  take_profit_px?: number | null;
  stop_loss_px?: number | null;
  /** USDC base units that reached Hyperliquid. */
  margin_usdc?: string | null;
  entry_size?: number | null;
  size: number;
  entry_px?: number | null;
  realized_pnl: number;
  fees_usd: number;
  funding_usd?: number | null;
  close_reason?: "tp" | "sl" | "guard" | "user" | null;
  /** USDC base units owed / paid. */
  payout_usdc?: string | null;
  payout_chain: number;
  payout_address: string;
  payout_ref?: string | null;
  status: string;
  error?: string | null;
  /** OPEN only: live mark and what the position is worth now. */
  mark_px?: number;
  equity_usd?: number;
}

const PERPS_VAULT_CHAIN_ID = 8453;

export async function fetchHyperliquidPositions(userId: string): Promise<HyperliquidPosition[]> {
  const base = getTradeExecutorBaseUrl(PERPS_VAULT_CHAIN_ID);
  const res = await fetch(`${base}/hyperliquid/positions/${encodeURIComponent(userId)}`, {
    headers: getCachedWalletAuthHeaders(userId),
  });
  if (!res.ok) throw new Error(`positions HTTP ${res.status}`);
  const json = await res.json();
  return (json?.positions ?? []) as HyperliquidPosition[];
}

/** Close an OPEN position now; the executor pays it out before answering. */
export async function exitHyperliquidPosition(positionId: string): Promise<HyperliquidPosition> {
  const signer = getSigner();
  if (!signer) throw new Error("Wallet required");
  const base = getTradeExecutorBaseUrl(PERPS_VAULT_CHAIN_ID);
  const res = await fetch(`${base}/hyperliquid/exit`, {
    method: "POST",
    headers: await getWalletWriteAuthHeaders(signer),
    body: JSON.stringify({ position_id: positionId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `exit HTTP ${res.status}`);
  return body.position as HyperliquidPosition;
}
