/**
 * Private-markets position tracking + early exit.
 *
 * A POLYMARKET strategy that has fired becomes a live position in the executor's escrow. This
 * module lists those positions and closes them before market resolution: the executor sells the
 * outcome shares on the CLOB and shields the proceeds back to the user's vault. A FULL close reuses
 * the position's original output note; a PARTIAL close mints a FRESH note for the sold portion (the
 * original stays reserved for the remainder).
 */
import type { TokenInfo } from "./zkHandler";
import { getTradeExecutorBaseUrl } from "./tradeExecutorClient";
import { getTokens } from "./networks";
import { createVaultOutputNote } from "./outputNoteResolver";
import { getSigner } from "./nexus";
import { getWalletWriteAuthHeaders, getCachedWalletAuthHeaders } from "./walletAuthHeaders";

export interface PolymarketPosition {
  id: string;
  strategy_id: string;
  user_id: string;
  market_id: string;
  token_id: string;
  outcome: string | null;
  side: string;
  entry_odds: number | null;
  shares: string | null;
  cost_usdc: string | null;
  status: "OPEN" | "REDEEMING" | "SETTLED" | "CLOSED" | "FAILED" | "CANCELLED";
  entry_tx: string | null;
  bridge_tx: string | null;
  redeem_tx: string | null;
  settle_tx: string | null;
  payout_usdc: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Market slug for polymarket.com/market/<slug> (absent on older strategies). */
  slug?: string | null;
}

const BASE_CHAIN_ID = 8453;

export async function fetchPolymarketPositions(userId: string): Promise<PolymarketPosition[]> {
  const res = await fetch(
    `${getTradeExecutorBaseUrl()}/polymarket/positions/${encodeURIComponent(userId.toLowerCase())}`,
    { headers: getCachedWalletAuthHeaders(userId) },
  );
  if (!res.ok) return [];
  const json = await res.json().catch(() => ({}));
  return (json?.positions ?? []) as PolymarketPosition[];
}

export interface ExitResult {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

/**
 * Close a position early. `fraction` defaults to 1 (full close). For a partial close the caller's
 * wallet mints a fresh output note so the sold portion shields to its own commitment.
 */
export async function exitPolymarketPosition(
  userId: string,
  positionId: string,
  fraction = 1,
): Promise<ExitResult> {
  try {
    const signer = getSigner();
    if (!signer) return { success: false, error: "Connect a wallet to close a position." };
    let outputPrecommitment: string | undefined;
    if (fraction < 1) {
      // Partial close needs a fresh note (the position's original is kept for the remainder).
      const usdc: TokenInfo = {
        symbol: "USDC",
        decimals: 6,
        address: getTokens(BASE_CHAIN_ID).USDC.address,
      };
      const note = await createVaultOutputNote(BASE_CHAIN_ID, usdc, signer);
      outputPrecommitment = note.precommitment;
    }
    // The exit route moves funds, so it is wallet-sig gated: ownership comes from the
    // recovered signature, not the body (user_id kept for backward compat/logging).
    const res = await fetch(`${getTradeExecutorBaseUrl()}/polymarket/exit`, {
      method: "POST",
      headers: await getWalletWriteAuthHeaders(signer),
      body: JSON.stringify({
        user_id: userId.toLowerCase(),
        position_id: positionId,
        fraction,
        ...(outputPrecommitment ? { output_precommitment: outputPrecommitment } : {}),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { success: false, error: json?.error || `Exit failed (${res.status})` };
    return { success: true, data: json };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Exit failed" };
  }
}
