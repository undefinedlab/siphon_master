/**
 * Private Polymarket bet submission — the execution rails behind PrivateTradeModal.
 *
 * Mirrors the single-shot vault strategy flow (Build.tsx): ZK-withdraw proof over the user's
 * shielded USDC notes + a vault-output note for the winnings + an FHE-encrypted odds trigger,
 * POSTed as a POLYMARKET strategy. The executor then (on trigger): withdraws shielded USDC on
 * Base → bridges to Polygon → places the CLOB order → the resolution watcher later redeems and
 * shields the payout back under our output precommitment.
 *
 * Odds trigger encoding (engine only has one-sided price arms; odds feed is 0..100 percent):
 *   "odds fall below X"  → trigger_dir 'below' → LIMIT_BUY_DIP,    lower_bound = X
 *   "odds rise above X"  → trigger_dir 'above' → LIMIT_SELL_RALLY, upper_bound = X
 *   "execute now"        → below 100 — always true for a 0..100 feed, fires first cycle
 */
import type { PolymarketMarket } from "@/app/api/polymarket/markets/route";
import { getSelectedChainId, getTokens, getZkWithdrawRecipient } from "./networks";
import { generateZKData, type TokenInfo } from "./zkHandler";
import { createVaultOutputNote } from "./outputNoteResolver";
import { getSigner } from "./nexus";
import {
  submitEncryptedStrategy,
  type SubmitCallbacks,
  type SubmitResult,
} from "./strategySubmit";

const BASE_CHAIN_ID = 8453;

export interface PolymarketTrigger {
  mode: "now" | "threshold";
  direction?: "above" | "below";
  oddsPct?: number;
}

export interface PolymarketBetParams {
  market: PolymarketMarket;
  outcomeIdx: number;
  amountUsd: number;
  trigger: PolymarketTrigger;
  cb?: SubmitCallbacks & { onProof?: () => void };
}

export async function submitPolymarketBet(params: PolymarketBetParams): Promise<SubmitResult> {
  const { market, outcomeIdx, amountUsd, trigger, cb } = params;

  const chainId = getSelectedChainId();
  if (chainId !== BASE_CHAIN_ID) {
    // The executor funds POLYMARKET entries from the Base USDC vault and bridges via LiFi;
    // testnets have no bridge route, and a spent note with no bridge would strand funds.
    return { success: false, error: "Private markets trade from your Base vault — switch the app to Base first." };
  }

  const tokenId = market.clobTokenIds?.[outcomeIdx];
  const outcome = market.outcomes?.[outcomeIdx];
  if (!tokenId || !outcome) {
    return { success: false, error: "This market is missing CLOB token data — try another market." };
  }
  if (!(amountUsd > 0)) {
    return { success: false, error: "Enter a positive USDC amount." };
  }

  const signer = getSigner();
  if (!signer) return { success: false, error: "Connect your wallet first." };
  const wallet = (await signer.getAddress()).toLowerCase();

  const usdc: TokenInfo = {
    symbol: "USDC",
    decimals: 6,
    address: getTokens(chainId).USDC.address,
  };

  // Trigger → one-sided bound (see header). Odds are percent 0..100, same scale the scheduler's
  // polymarket_oracle reports, so ciphertext and live value compare in the same units.
  const dir: "above" | "below" = trigger.mode === "now" ? "below" : (trigger.direction ?? "above");
  const threshold = trigger.mode === "now" ? 100 : Math.min(100, Math.max(0, trigger.oddsPct ?? 50));
  const upper_bound = dir === "above" ? threshold : 0;
  const lower_bound = dir === "below" ? threshold : 0;

  // 1. ZK-withdraw proof over the user's shielded USDC notes (nullifier spent only on trigger).
  cb?.onProof?.();
  const zk = await generateZKData(chainId, usdc, String(amountUsd), getZkWithdrawRecipient(chainId));
  if ("error" in zk) {
    return { success: false, error: `ZK proof failed: ${zk.error}` };
  }
  const txData = zk.withdrawalTxData;
  const zkProof = {
    stateRoot: txData.stateRoot,
    nullifierHashes: txData.nullifierHashes,
    changeCommitment: txData.changeCommitment,
    amount: txData.amount,
    pA: txData.pA,
    pB: txData.pB,
    pC: txData.pC,
  };

  // 2. Winnings note: secret stays here (backed up encrypted), executor gets only the precommitment.
  const out = await createVaultOutputNote(chainId, usdc, signer);

  // 3. FHE-encrypt the odds bounds + POST. Extra fields (poly_meta, price_feed_id) pass through.
  return submitEncryptedStrategy(
    {
      user_id: wallet,
      strategy_type: "POLYMARKET",
      side: "buy",
      asset_in: "USDC",
      asset_out: "USDC",
      amount: amountUsd,
      upper_bound,
      lower_bound,
      recipient_address: wallet,
      zk_proof: zkProof,
      is_private: true,
      commitment_ids: zk.spentDepositKeys.map((k: string) => zk.serverCommitmentIds[k] ?? null),
      condition_tree: null,
      from_chain: String(chainId),
      to_chain: String(chainId),
      output_mode: "vault",
      output_precommitment: out.precommitment,
      price_feed_id: `polymarket:${tokenId}`,
      poly_meta: {
        market_id: market.id,
        condition_id: market.conditionId || undefined,
        token_id: String(tokenId),
        outcome,
        side: "BUY",
        entry_odds: Math.round((market.odds?.[outcomeIdx] ?? 0) * 100),
        trigger_dir: dir,
        // For the positions panel's "view on Polymarket" link (polymarket.com/market/<slug>).
        slug: market.slug || undefined,
      },
    },
    cb,
  );
}
