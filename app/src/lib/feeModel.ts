/**
 * Siphon fee model — frontend source of truth for the published pricing sheet (v1.0, Aug 2026).
 * MUST stay in sync with siphon-fhe/trade-executor/fee_config.py (the backend actually charges).
 *
 *   Arming   $0.25 per strategy, upfront, non-refundable, one per strategy whatever its leg count.
 *   Window   Priced once at arming from the execution window the order asks for
 *            (1h $0.25 / 24h $0.50 / 7d $2.00 / 30d $5.00). Non-refundable — a window is an
 *            option on execution time, so filling early is a good outcome, not an overpayment.
 *   Fill     A flat 0.20% of notional executed, deducted from the trade. No floor, no minimum,
 *            no per-leg charge. Partners on the API pay 0.05% (EXEC_BPS_API) — quoted here so
 *            the two rates live in one place, but the browser only ever charges retail.
 *
 * Withdrawal is not priced here: exiting the vault costs network gas only, charged on-chain by
 * Vault/WithdrawFee.sol with feeBps = 0 and a FLAT gas leg.
 *
 * Arming + window go out as ONE USDC transfer to the executor before the strategy is accepted.
 *
 * CUTOVER (done 2026-08-22): the executor was deployed first, so it accepts >= the required
 * amount and records what actually arrives. That is what makes it safe for this side to send
 * arming+window. Sending MORE than the executor requires is fine; sending less is the 402.
 * NEXT_PUBLIC_FEE_WINDOW_ENABLED=0 is the kill switch — it drops this side back to the bare
 * $0.25, which the executor still accepts, so it is a safe unilateral rollback.
 */
export const FEE = {
  // Fill
  EXEC_BPS: 20,            // 0.20% of notional — retail
  EXEC_BPS_API: 5,         // 0.05% of notional — partners via the API gateway
  // Arming
  ARMING_USDC: 0.25,
  // Limits
  MAX_LEGS: 50,
} as const;

/** (maxHours, usd) ascending — the first tier that covers the window wins. */
export const WINDOW_TIERS_USD: ReadonlyArray<readonly [number, number]> = [
  [1, 0.25],
  [24, 0.5],
  [168, 2.0],
  [720, 5.0],
] as const;

/**
 * Whether the window leg is charged at all. Reads at call time, not module load, so tests can
 * flip it. On by default now that the executor accepts it; set the env var to "0" to roll back.
 */
export function windowFeeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEE_WINDOW_ENABLED !== "0";
}

/** Price of the execution window. Anything longer than the last tier pays the last tier. */
export function windowFeeUsd(windowHours: number): number {
  if (!windowFeeEnabled()) return 0;
  const hours = Math.max(0, windowHours || 0);
  for (const [maxHours, usd] of WINDOW_TIERS_USD) {
    if (hours <= maxHours) return usd;
  }
  return WINDOW_TIERS_USD[WINDOW_TIERS_USD.length - 1][1];
}

/** What the user transfers upfront: arming + the window it asked for. */
export function armingChargeUsd(windowHours: number): number {
  return FEE.ARMING_USDC + windowFeeUsd(windowHours);
}

/** The same charge in USDC base units (6 decimals) — what actually gets transferred. */
export function armingChargeUsdcWei(windowHours: number): bigint {
  return BigInt(Math.round(armingChargeUsd(windowHours) * 1e6));
}

/** Bare arming fee in USDC base units, for callers with no window to price. */
export const ARMING_FEE_USDC_WEI = BigInt(Math.round(FEE.ARMING_USDC * 1e6));

/** @deprecated Use armingChargeUsd — the window is no longer free. */
export function armingFeeUsd(windowHours: number): number {
  return armingChargeUsd(windowHours);
}

/** Per-fill fee (USD) deducted from the trade output. Flat percentage, no floor. */
export function executionFeeUsd(notionalUsd: number, isApi = false): number {
  const bps = isApi ? FEE.EXEC_BPS_API : FEE.EXEC_BPS;
  return (bps / 10000) * Math.max(0, notionalUsd || 0);
}
