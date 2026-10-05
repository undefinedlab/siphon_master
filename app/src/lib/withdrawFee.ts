/**
 * Withdrawal-fee client helper.
 *
 * Reads the on-chain fee config from the asset's vault and quotes the fee for a withdrawal — using
 * the SAME `quoteWithdrawFee` view the contract's withdraw path computes from, so the number the UI
 * shows always matches what the contract actually deducts (no client/contract drift).
 *
 * Two UX modes:
 *   • exact-send    — user enters withdrawnValue; recipient receives `withdrawnValue - fee`.
 *   • exact-receive — user enters the amount the recipient should get; we solve the withdrawnValue
 *                     `w` such that `w - fee(w) = target`.
 *
 * Fee is DORMANT by default on-chain (feeBps=0) → quotes return zero fee until the owner enables it.
 */
import { ethers, Contract } from "ethers";
import { NATIVE_TOKEN, getTokens } from "./networks";
import { getReadProvider, resolveVault } from "./zkHandler";
import { v3Deployed } from "./v3/configV3";

// Minimal ABI for the fee views (the bundled NativeVault.json predates the fee module).
const FEE_ABI = [
  "function getFeeInfo() view returns (bool enabled, uint8 gasMode, uint16 feeBps, uint256 minWithdrawWei)",
  "function quoteWithdrawFee(uint256 withdrawnValue, uint256 n) view returns (uint256 fee, uint256 margin, uint256 gasReimburse)",
];

export interface FeeInfo {
  enabled: boolean;
  gasMode: number;        // 0 = FLAT, 1 = ORACLE
  feeBps: number;         // protocol margin bps
  minWithdrawWei: bigint; // dust floor
}

export interface FeeQuote {
  /** total fee in the asset's smallest unit (wei / 6-dec USDC). */
  feeWei: bigint;
  marginWei: bigint;
  gasReimburseWei: bigint;
  /** withdrawnValue spent from the pool (input to the quote). */
  withdrawnValueWei: bigint;
  /** what the recipient actually receives = withdrawnValue - fee. */
  recipientReceivesWei: bigint;
  /** true when the withdrawal would revert (below minWithdraw, or fee >= amount). */
  belowMinimum: boolean;
  feeExceedsAmount: boolean;
}

function tokenAddressFor(symbol: string, chainId?: number): string {
  if (symbol === "ETH") return NATIVE_TOKEN;
  const t = Object.values(getTokens(chainId)).find((x) => x.symbol === symbol);
  if (!t) throw new Error(`Unknown token ${symbol}`);
  return t.address;
}

async function feeContract(symbol: string, chainId?: number): Promise<Contract> {
  const { vault } = await resolveVault(tokenAddressFor(symbol, chainId), chainId);
  return new Contract(await vault.getAddress(), FEE_ABI, getReadProvider(chainId));
}

/**
 * Read the active fee config. Returns a disabled config if the view is absent (pre-fee contract).
 *
 * "The vault has no fee module" and "the RPC did not answer" are NOT the same thing, and this used
 * to swallow both into `enabled: false` — a confident "this withdrawal is free". The damage is
 * quiet and compounding: solveWithdrawForExactReceive calls this a second time, so a single flaky
 * read there made the fee disappear from an otherwise correct quote, the UI rendered a withdrawal
 * with no fee, and the amount it produced would revert on-chain. Base showed exactly this — a
 * 0.03 USDC flat gas reimbursement reported as gross 24238 / fee 0.
 *
 * A missing function reverts (CALL_EXCEPTION / BAD_DATA with no return data); a transport failure
 * does not. Only the former is legitimately "no fee module"; the latter must propagate so callers
 * can say the fee is UNKNOWN rather than free.
 */
export async function getFeeInfo(symbol: string, chainId?: number): Promise<FeeInfo> {
  // A v3 chain has no withdrawal fee AT ALL, and asking the v2 vault about it is asking the wrong
  // contract. VaultKernel._payout sends `PublicInputs.primaryValue(pi)` in full — there is no
  // deduction anywhere on the spend path, and no fee module to read. `resolveVault` still answers,
  // because the retired v2 vault for this token is deployed and does have a fee config; the number
  // it returns just has nothing to do with how a v3 withdrawal settles.
  //
  // Confirmed against the first Base mainnet withdrawal: quoted 0.494238 net of a 0.03 "gas
  // reimbursement", actually received the full 0.524238. Overstating is the safe direction, but it
  // made Max reserve 0.03 that is never spent — which is exactly what made withdrawing the whole
  // balance impossible while the balance was small.
  //
  // Same shape as the v3 balance falling back to the legacy vault scan (69837e5): on a v3 chain the
  // v2 contracts are not a fallback, they are a different protocol.
  if (chainId !== undefined && v3Deployed(chainId)) {
    return { enabled: false, gasMode: 0, feeBps: 0, minWithdrawWei: 0n };
  }
  try {
    const c = await feeContract(symbol, chainId);
    const [enabled, gasMode, feeBps, minWithdrawWei] = await c.getFeeInfo();
    return { enabled, gasMode: Number(gasMode), feeBps: Number(feeBps), minWithdrawWei };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "CALL_EXCEPTION" || code === "BAD_DATA") {
      // Vault without the fee module (older deployment) → genuinely no fee.
      return { enabled: false, gasMode: 0, feeBps: 0, minWithdrawWei: 0n };
    }
    throw e;
  }
}

/**
 * EXACT-SEND: quote the fee for spending `withdrawnValueWei` from the pool.
 * `n` = number of input notes the withdrawal will spend (affects ORACLE-mode gas; irrelevant in
 * FLAT). Defaults to 1 — exact for FLAT, a close estimate for ORACLE display.
 */
export async function quoteWithdrawFee(
  symbol: string,
  withdrawnValueWei: bigint,
  n = 1,
  chainId?: number,
): Promise<FeeQuote> {
  const info = await getFeeInfo(symbol, chainId);
  if (!info.enabled || withdrawnValueWei <= 0n) {
    return {
      feeWei: 0n, marginWei: 0n, gasReimburseWei: 0n,
      withdrawnValueWei, recipientReceivesWei: withdrawnValueWei,
      belowMinimum: false, feeExceedsAmount: false,
    };
  }
  const c = await feeContract(symbol, chainId);
  const [fee, margin, gasReimburse] = await c.quoteWithdrawFee(withdrawnValueWei, n);
  const feeWei = BigInt(fee), marginWei = BigInt(margin), gasReimburseWei = BigInt(gasReimburse);
  const belowMinimum = info.minWithdrawWei > 0n && withdrawnValueWei < info.minWithdrawWei;
  const feeExceedsAmount = withdrawnValueWei <= feeWei;
  return {
    feeWei, marginWei, gasReimburseWei, withdrawnValueWei,
    recipientReceivesWei: feeExceedsAmount ? 0n : withdrawnValueWei - feeWei,
    belowMinimum, feeExceedsAmount,
  };
}

/**
 * EXACT-RECEIVE: given a target amount the recipient should receive, solve the withdrawnValue `w`
 * such that `w - fee(w) = target`.
 *
 * For the current fee model `fee = margin + gasReimburse` where `margin = w*feeBps/10000` and
 * `gasReimburse` is (in FLAT) constant / (in ORACLE) independent of `w`, this is closed-form:
 *   target = w - (w*feeBps/10000 + g)  =>  w = (target + g) * 10000 / (10000 - feeBps)
 * We then re-quote the solved `w` to get the EXACT fee (handles the cap edge + rounding), nudging
 * up by 1 wei if rounding left the recipient a hair short.
 */
/**
 * Closed-form inverse of the margin: the smallest `w` with `w - (w*feeBps/10000 + g) >= target`.
 *
 * Rounds UP only when the division has a remainder. It used to add 1n unconditionally as
 * "ceil-division safety", which is only safe when there IS a remainder — with feeBps=0, the live
 * config on every vault, the division is always exact and the +1 was pure overshoot. The
 * correction loop in the caller only bumps `w` up, never down, so every exact-receive quote came
 * out one minor unit high. That is invisible until the amount is the whole balance: Max fills
 * balance-minus-fee, this solved it back to balance+1, and the withdrawal was refused over a
 * single unit the user could not possibly have.
 */
export function grossForExactReceive(
  targetReceiveWei: bigint,
  gasReimburseWei: bigint,
  feeBps: bigint,
): bigint {
  const num = (targetReceiveWei + gasReimburseWei) * 10000n;
  const den = 10000n - feeBps;
  return num / den + (num % den === 0n ? 0n : 1n);
}

export async function solveWithdrawForExactReceive(
  symbol: string,
  targetReceiveWei: bigint,
  n = 1,
  chainId?: number,
): Promise<FeeQuote> {
  const info = await getFeeInfo(symbol, chainId);
  if (!info.enabled || targetReceiveWei <= 0n) {
    return {
      feeWei: 0n, marginWei: 0n, gasReimburseWei: 0n,
      withdrawnValueWei: targetReceiveWei, recipientReceivesWei: targetReceiveWei,
      belowMinimum: false, feeExceedsAmount: false,
    };
  }
  // Estimate the gas leg by quoting once at the target (gas leg is w-independent).
  const probe = await quoteWithdrawFee(symbol, targetReceiveWei, n, chainId);
  const g = probe.gasReimburseWei;
  let w = grossForExactReceive(targetReceiveWei, g, BigInt(info.feeBps));

  // Re-quote the solved w and correct: bump w until recipient >= target (at most a few 1-wei steps).
  let quote = await quoteWithdrawFee(symbol, w, n, chainId);
  for (let i = 0; i < 4 && quote.recipientReceivesWei < targetReceiveWei; i++) {
    w += targetReceiveWei - quote.recipientReceivesWei;
    quote = await quoteWithdrawFee(symbol, w, n, chainId);
  }
  return quote;
}

/** Format a wei amount for display in the given token's decimals. */
export function formatFeeAmount(wei: bigint, symbol: string, chainId?: number): string {
  const decimals = symbol === "ETH" ? 18 : (Object.values(getTokens(chainId)).find((t) => t.symbol === symbol)?.decimals ?? 18);
  return ethers.formatUnits(wei, decimals);
}
