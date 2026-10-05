import { activeSwapDexesForChain, activeTokensForChain, isActiveToken } from "./blocks";
import type { MissingField, ParsedPrompt, StrategyKind } from "./types";
import { SINGLE_PRICE_STRATEGIES } from "../lib/strategySpec";

const QUESTION_BUILDERS: Record<MissingField, (parsed: ParsedPrompt) => string> = {
  coin: () => {
    const tokens = activeTokensForChain().join(" or ");
    return `Which token should the deposit use? (e.g. ${tokens})`;
  },
  inactiveToken: (parsed) => {
    const tokens = activeTokensForChain().join(" or ");
    return `${parsed.coin} isn't active on this chain — which token should we use instead? (${tokens})`;
  },
  amount: (parsed) =>
    `How much ${parsed.coin ?? "token"} do you want to deposit?`,
  side: () => "Should this be a buy or sell?",
  priceGoal: (parsed) => {
    switch (parsed.strategy) {
      case "Stop Loss":
        return "What stop price should trigger the exit?";
      case "Take Profit":
        return "What target price should take profit?";
      default:
        return "What limit price should trigger the order?";
    }
  },
  rangeLow: () => "What is the lower bound of the range?",
  rangeHigh: () => "What is the upper bound of the range?",
  gridLevels: () => "How many grid levels? (e.g. 5)",
  sliceCount: () => "How many TWAP slices? (e.g. 10)",
  intervalSeconds: () =>
    "How many seconds between slices? (e.g. 300 for 5 minutes)",
  loopInterval: () =>
    "How often should the loop run? (e.g. every 24 hours, every 30 minutes)",
  toCoin: (parsed) =>
    `Which token should we swap ${parsed.coin ?? "your deposit"} into?`,
  dex: () => {
    const venues = activeSwapDexesForChain();
    if (venues.length <= 1) {
      return `Confirm swap venue: ${venues[0] ?? "the available exchange"}?`;
    }
    return `Which exchange should we swap on — ${venues.join(", ").replace(/, ([^,]*)$/, ", or $1")}?`;
  },
  wallet: () => "What wallet address should receive the withdrawal?",
  polyMarket: () =>
    "Which market do you want to bet on? Describe it like the Polymarket title (e.g. “Will BTC hit $150k by March?”).",
  polyOutcome: (parsed) =>
    parsed.polyOutcomes && parsed.polyOutcomes.length >= 2
      ? `Which outcome do you want to back — ${parsed.polyOutcomes.slice(0, 4).join(" or ")}?`
      : "Which outcome do you want to back? (e.g. Yes or No)",
  hlCoin: () => "Which perp market — BTC, ETH, SOL, or HYPE?",
};

function needsPriceGoal(strategy: StrategyKind): boolean {
  return SINGLE_PRICE_STRATEGIES.includes(strategy);
}

export function getMissingFields(parsed: ParsedPrompt): MissingField[] {
  const missing: MissingField[] = [];

  // Perps / Predictions fund from shielded USDC — skip generic coin prompt.
  if (parsed.strategy === "Perps") {
    if (!parsed.hlCoin) missing.push("hlCoin");
    if (!parsed.amount) missing.push("amount");
    return missing;
  }

  if (!parsed.coin) {
    missing.push("coin");
  } else if (!isActiveToken(parsed.coin)) {
    missing.push("inactiveToken");
  }

  if (!parsed.amount) {
    missing.push("amount");
  }

  if (parsed.useLoop) {
    if (!parsed.loopIntervalValue) missing.push("loopInterval");
    if (parsed.includeSwap && !parsed.toCoin) missing.push("toCoin");
    if (parsed.includeSwap && !parsed.dex && activeSwapDexesForChain().length > 1) {
      missing.push("dex");
    }
    if (parsed.includeWithdraw && !parsed.wallet) missing.push("wallet");
    return missing;
  }

  if (parsed.strategy === "Predictions") {
    if (!parsed.polyMarketQuery && !parsed.polyTokenId) missing.push("polyMarket");
    if (!parsed.polyOutcome) missing.push("polyOutcome");
    return missing;
  }

  if (needsPriceGoal(parsed.strategy) && !parsed.priceGoal) {
    missing.push("priceGoal");
  }

  if (parsed.strategy === "Range") {
    if (!parsed.rangeLow) missing.push("rangeLow");
    if (!parsed.rangeHigh) missing.push("rangeHigh");
    if (!parsed.gridLevels) missing.push("gridLevels");
  }

  if (parsed.strategy === "TWAP") {
    if (!parsed.sliceCount) missing.push("sliceCount");
    if (!parsed.intervalSeconds) missing.push("intervalSeconds");
  }

  if (parsed.includeSwap && !parsed.toCoin) {
    missing.push("toCoin");
  }

  if (parsed.includeSwap && !parsed.dex && activeSwapDexesForChain().length > 1) {
    missing.push("dex");
  }

  if (parsed.includeWithdraw && !parsed.wallet) {
    missing.push("wallet");
  }

  return missing;
}

export function getQuestionForField(
  field: MissingField,
  parsed: ParsedPrompt
): string {
  return QUESTION_BUILDERS[field](parsed);
}

export function getNextQuestion(parsed: ParsedPrompt): {
  field: MissingField;
  question: string;
} | null {
  const missing = getMissingFields(parsed);
  if (missing.length === 0) return null;
  const field = missing[0];
  return { field, question: getQuestionForField(field, parsed) };
}
