import { normalizeStrategyKind } from "../lib/strategySpec";
import { BRIDGE_DESTS } from "../lib/bridge/hub";
import { defaultDexForChain, normalizeDex, type BuilderChainOpts } from "./blocks";
import { normalizePipelineHops } from "./pipelineHops";
import type { ParsedPrompt, StrategySide } from "./types";

/** Snapshot sent to the LLM on follow-up turns. */
export function parsedToFlowSnapshot(
  parsed: ParsedPrompt,
  extras?: BuilderChainOpts & { chainId?: number },
): Record<string, unknown> {
  return {
    strategy: parsed.strategy,
    side: parsed.side,
    coin: parsed.coin,
    toCoin: parsed.toCoin,
    dex: parsed.dex,
    amount: parsed.amount,
    swapAmount: parsed.swapAmount,
    priceGoal: parsed.priceGoal,
    rangeLow: parsed.rangeLow,
    rangeHigh: parsed.rangeHigh,
    gridLevels: parsed.gridLevels,
    sliceCount: parsed.sliceCount,
    intervalSeconds: parsed.intervalSeconds,
    includeSwap: parsed.includeSwap,
    includeWithdraw: parsed.includeWithdraw,
    includeLend: parsed.includeLend,
    lendAction: parsed.lendAction,
    pipelineHops: parsed.pipelineHops,
    withdrawChain: parsed.withdrawChain,
    includeBridge: parsed.includeBridge,
    bridgeToChain: parsed.bridgeToChain,
    useLoop: parsed.useLoop,
    loopIntervalValue: parsed.loopIntervalValue,
    loopIntervalUnit: parsed.loopIntervalUnit,
    includeSchedule: parsed.includeSchedule,
    scheduleValue: parsed.scheduleValue,
    scheduleUnit: parsed.scheduleUnit,
    wallet: parsed.wallet,
    polyMarketQuery: parsed.polyMarketQuery,
    polyOutcome: parsed.polyOutcome,
    polyMarketQuestion: parsed.polyMarketQuestion,
    polyOdds: parsed.polyOdds,
    ...(extras?.chainId != null ? { chainId: extras.chainId } : {}),
    ...(extras?.homeChainId ? { homeChainId: extras.homeChainId } : {}),
  };
}

/** Keep-private vault labels + every LI.FI payout label (deduped — Base is both). */
const WITHDRAW_CHAINS = [...new Set(["Base", "Arbitrum", ...BRIDGE_DESTS.map((d) => d.label)])];

/** The only chain an address can belong to, when its shape says so (Zcash before Solana: a t-address
 *  is valid base58 too). EVM addresses fit every EVM chain, so they decide nothing. */
export function addressOnlyChain(addr: string | null | undefined): string | null {
  const a = (addr ?? "").trim();
  if (/^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(a) || /^u1[02-9ac-hj-np-z]{60,}$/.test(a)) return "Zcash";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return "Solana";
  return null;
}

/** Merge LLM JSON onto prior parsed state — null/omitted LLM fields keep previous values. */
export function mergeLlmOntoParsed(
  base: ParsedPrompt,
  llm: Record<string, unknown>,
  latestPrompt: string,
  chainOpts?: BuilderChainOpts,
): ParsedPrompt {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(llm, key);

  const str = (key: string): string | null => {
    if (!has(key)) return null;
    const v = llm[key];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };

  const bool = (key: string): boolean | null => {
    if (!has(key)) return null;
    return typeof llm[key] === "boolean" ? (llm[key] as boolean) : null;
  };

  const sideRaw = has("side") ? llm.side : undefined;
  const side: StrategySide | null =
    sideRaw === "buy" || sideRaw === "sell"
      ? sideRaw
      : sideRaw === null
        ? base.side
        : base.side;

  const strategyRaw = str("strategy");

  let amount = str("amount") ?? base.amount;
  let swapAmount = str("swapAmount") ?? base.swapAmount;

  // LLM often puts per-swap size in `amount` — don't clobber deposit total.
  const amountFromLlm = str("amount");
  if (
    amountFromLlm &&
    !has("swapAmount") &&
    base.useLoop &&
    base.amount &&
    parseFloat(amountFromLlm) < parseFloat(base.amount)
  ) {
    amount = base.amount;
    swapAmount = amountFromLlm;
  }

  // Predictions: a changed market description or outcome invalidates the resolved token id
  // (token ids are per-market AND per-outcome), forcing the resolution step to run again.
  const polyMarketQuery = str("polyMarketQuery") ?? base.polyMarketQuery;
  const polyOutcome = str("polyOutcome") ?? base.polyOutcome;
  const polyInvalidated =
    (base.polyMarketQuery !== null && polyMarketQuery !== base.polyMarketQuery) ||
    (base.polyOutcome !== null && polyOutcome !== base.polyOutcome);

  // A pasted Solana or Zcash address can only land on that chain, whatever the model picked — the
  // canvas once showed "Withdraw to Arbitrum" holding a Solana address.
  const wallet = str("wallet") ?? base.wallet;
  const llmChain = str("withdrawChain");
  const withdrawChain =
    addressOnlyChain(wallet) ??
    WITHDRAW_CHAINS.find((c) => c.toLowerCase() === llmChain?.toLowerCase()) ??
    base.withdrawChain;

  const includeSwap = bool("includeSwap") ?? base.includeSwap;
  let dex = base.dex;
  if (has("dex")) {
    const raw = llm.dex;
    if (raw === null || raw === "") {
      dex = null;
    } else if (typeof raw === "string") {
      dex = normalizeDex(raw, chainOpts);
    }
  } else if (includeSwap && !dex) {
    // Singular-venue chains fill immediately; multi-venue stays null so we ask.
    dex = defaultDexForChain(chainOpts);
  }

  return {
    ...base,
    raw: base.raw ? `${base.raw}\n${latestPrompt}`.trim() : latestPrompt,
    withdrawChain,
    strategy: strategyRaw ? normalizeStrategyKind(strategyRaw) : base.strategy,
    polyMarketQuery,
    polyOutcome,
    polyTokenId: polyInvalidated ? null : base.polyTokenId,
    polyMarketId: polyInvalidated ? null : base.polyMarketId,
    polyMarketQuestion: polyInvalidated ? null : base.polyMarketQuestion,
    polyOdds: polyInvalidated ? null : base.polyOdds,
    polyOutcomes: polyInvalidated ? null : base.polyOutcomes,
    hlCoin: str("hlCoin") ?? base.hlCoin,
    hlLeverage: str("hlLeverage") ?? base.hlLeverage,
    hlTakeProfit: str("hlTakeProfit") ?? base.hlTakeProfit,
    hlStopLoss: str("hlStopLoss") ?? base.hlStopLoss,
    side,
    coin: str("coin") ?? base.coin,
    toCoin: str("toCoin") ?? base.toCoin,
    dex,
    amount,
    swapAmount,
    priceGoal: str("priceGoal") ?? base.priceGoal,
    rangeLow: str("rangeLow") ?? base.rangeLow,
    rangeHigh: str("rangeHigh") ?? base.rangeHigh,
    gridLevels: str("gridLevels") ?? base.gridLevels,
    sliceCount: str("sliceCount") ?? base.sliceCount,
    intervalSeconds: str("intervalSeconds") ?? base.intervalSeconds,
    wallet,
    includeSwap,
    includeWithdraw: bool("includeWithdraw") ?? base.includeWithdraw,
    includeLend: bool("includeLend") ?? base.includeLend,
    lendAction: (() => {
      const raw = str("lendAction") ?? base.lendAction;
      if (!raw) return base.lendAction;
      const v = raw.toLowerCase();
      return v === "exit" ? "exit" : v === "enter" ? "enter" : base.lendAction;
    })(),
    pipelineHops: normalizePipelineHops(has("pipelineHops") ? llm.pipelineHops : null) ?? base.pipelineHops,
    includeBridge: bool("includeBridge") ?? base.includeBridge,
    bridgeToChain: str("bridgeToChain") ?? base.bridgeToChain,
    useLoop: bool("useLoop") ?? base.useLoop,
    loopIntervalValue: str("loopIntervalValue") ?? base.loopIntervalValue,
    loopIntervalUnit: str("loopIntervalUnit") ?? base.loopIntervalUnit,
    includeSchedule: bool("includeSchedule") ?? base.includeSchedule,
    scheduleValue: str("scheduleValue") ?? base.scheduleValue,
    scheduleUnit: str("scheduleUnit") ?? base.scheduleUnit,
  };
}
