import { normalizeToken } from "./blocks";
import { isMultiPhaseFlowPrompt } from "./flowCapabilities";
import type { ParsedPrompt } from "./types";

const DIP_PATTERNS = [
  /(\d+(?:\.\d+)?)\s*%\s*(?:dip|drop|down|off|from\s+(?:now|current|today)|(?:from\s+)?now'?s?\s*price)/i,
  /(?:dip|drop|down|off)\s*(?:of|by|like)?\s*(\d+(?:\.\d+)?)\s*%/i,
  /takes?\s+like\s+(\d+(?:\.\d+)?)\s*%/i,
  /(\d+(?:\.\d+)?)\s*%\s*(?:lower|below|under)/i,
  /(\d+(?:\.\d+)?)\s*%\s*(?:from\s+)?(?:now|current)/i,
];

/** Compute limit priceGoal from "8% dip from current ETH price". */
export function applyPercentDipPrice(
  parsed: ParsedPrompt,
  prompt: string,
  ethUsd: number | null
): ParsedPrompt {
  if (!ethUsd || ethUsd <= 0) return parsed;
  const trimmed = prompt.trim();

  for (const pattern of DIP_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const pct = parseFloat(match[1]);
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) continue;

    const target = ethUsd * (1 - pct / 100);
    return {
      ...parsed,
      strategy: "Limit Order",
      side: parsed.side ?? "buy",
      priceGoal: target.toFixed(2),
      includeSwap: true,
      toCoin: parsed.toCoin ?? "ETH",
      coin: parsed.coin ?? "USDC",
    };
  }

  return parsed;
}

const TAKE_PROFIT_PATTERNS = [
  /take[\s-]?profit\s+(?:at|when|@)?\s*(\d+(?:\.\d+)?)\s*%/i,
  /(\d+(?:\.\d+)?)\s*%\s*(?:gain|profit|above|over|up\s+from)/i,
  /(\d+(?:\.\d+)?)\s*%\s*(?:above|over)\s+(?:now|current|today)(?:'s)?\s*price/i,
];

/** Compute take-profit priceGoal from "8% above current ETH price". */
export function applyPercentTakeProfitPrice(
  parsed: ParsedPrompt,
  prompt: string,
  ethUsd: number | null
): ParsedPrompt {
  if (!ethUsd || ethUsd <= 0) return parsed;
  const trimmed = prompt.trim();
  if (!/\btake[\s-]?profit\b/i.test(trimmed) && !/\b(?:gain|profit)\s+(?:at|target)\b/i.test(trimmed)) {
    return parsed;
  }

  for (const pattern of TAKE_PROFIT_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const pct = parseFloat(match[1]);
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) continue;

    const target = ethUsd * (1 + pct / 100);
    return {
      ...parsed,
      useLoop: false,
      strategy: "Take Profit",
      side: "sell",
      priceGoal: target.toFixed(2),
      includeSwap: true,
      toCoin: parsed.toCoin ?? "USDC",
      coin: parsed.coin ?? "ETH",
      includeWithdraw: parsed.includeWithdraw || /\bwithdraw\b/i.test(trimmed),
    };
  }

  return parsed;
}

/** "buy 0.0636 ETH every 24h" in a USDC loop → USDC per-swap from live ETH price. */
export function applyFixedEthLoopBuy(
  parsed: ParsedPrompt,
  prompt: string,
  ethUsd: number | null
): ParsedPrompt {
  const match = prompt.match(/\bbuy\s+(\d+(?:\.\d+)?)\s+eth\b/i);
  if (!match || !ethUsd || ethUsd <= 0) return parsed;
  if (!parsed.useLoop && !isMultiPhaseFlowPrompt(prompt)) return parsed;

  const ethQty = parseFloat(match[1]);
  if (!Number.isFinite(ethQty) || ethQty <= 0) return parsed;

  return {
    ...parsed,
    useLoop: true,
    includeSwap: true,
    coin: parsed.coin ?? "USDC",
    toCoin: parsed.toCoin ?? "ETH",
    side: parsed.side ?? "buy",
    swapAmount: (ethQty * ethUsd).toFixed(2),
  };
}

type ScheduleUnit = "seconds" | "minutes" | "hours" | "blocks";

const WAIT_AFTER_PATTERN =
  /\b(?:wait|after|delay|in|start(?:\s+(?:in|after))?)\s+(\d+)\s*(blocks?|seconds?|minutes?|hours?)\b/i;

const TOKEN_PATTERN = /\b(eth|usdc|usdt|wbtc|sol|xmr)\b/i;
const AMOUNT_TOKEN_PATTERN =
  /\b(?:deposit\s+)?(\d+(?:\.\d+)?)\s*(eth|usdc|usdt|wbtc|sol|xmr)\b/i;
const TOKEN_AMOUNT_PATTERN =
  /\b(eth|usdc|usdt|wbtc|sol|xmr)\s+(\d+(?:\.\d+)?)\b/i;

function normalizeScheduleUnit(raw: string): ScheduleUnit {
  const base = raw.toLowerCase().replace(/s$/, "");
  if (base === "block") return "blocks";
  if (base === "second" || base === "minute" || base === "hour") return `${base}s` as ScheduleUnit;
  return base as ScheduleUnit;
}

/** Safety net when the LLM omits Schedule / Loop flags present in the user text. */
export function augmentParsedFromPrompt(parsed: ParsedPrompt, prompt: string): ParsedPrompt {
  const trimmed = prompt.trim();
  let next = { ...parsed };

  const waitMatch = trimmed.match(WAIT_AFTER_PATTERN);
  if (waitMatch && !next.useLoop) {
    next = {
      ...next,
      includeSchedule: true,
      scheduleValue: next.scheduleValue ?? waitMatch[1],
      scheduleUnit: next.scheduleUnit ?? normalizeScheduleUnit(waitMatch[2]),
    };
  } else if (/\b(?:wait|delay)\b/i.test(trimmed) && !next.useLoop) {
    next = { ...next, includeSchedule: true };
  }

  if (/\b(?:buy\s+(?:the\s+)?dip|limit\s+buy|when\s+price\s+dips?)\b/i.test(trimmed)) {
    next = {
      ...next,
      useLoop: false,
      strategy: next.strategy === "Limit Order" ? next.strategy : "Limit Order",
      side: next.side ?? "buy",
    };
  }

  if (isMultiPhaseFlowPrompt(trimmed)) {
    next = {
      ...next,
      useLoop: true,
      includeSwap: true,
      priceGoal: null,
      coin: next.coin ?? "USDC",
      toCoin: next.toCoin ?? "ETH",
      side: next.side ?? "buy",
      loopIntervalValue: next.loopIntervalValue ?? "24",
      loopIntervalUnit: next.loopIntervalUnit ?? "hours",
    };
  }

  return next;
}

/** Split vault deposit total vs per-loop swap size when user gives both. */
export function inferDualAmounts(parsed: ParsedPrompt, prompt: string): ParsedPrompt {
  const trimmed = prompt.trim();
  let next = { ...parsed };

  const depositUseMatch = trimmed.match(
    /\bdeposit\s+(\d+(?:\.\d+)?)\b.*?(?:use|only|just)\s+(?:just\s+)?(\d+(?:\.\d+)?)\b/i
  );
  if (depositUseMatch) {
    next = {
      ...next,
      useLoop: true,
      includeSwap: true,
      amount: depositUseMatch[1],
      swapAmount: depositUseMatch[2],
    };
  }

  const perSwapMatch = trimmed.match(
    /\b(\d+(?:\.\d+)?)\s+(?:usdc|eth|usd)?\s*(?:per|each)\s+(?:swap|event|iteration|loop|time)/i
  );
  const depositMatch = trimmed.match(/\bdeposit\s+(\d+(?:\.\d+)?)\b/i);
  if (perSwapMatch && depositMatch) {
    next = {
      ...next,
      useLoop: true,
      includeSwap: true,
      amount: depositMatch[1],
      swapAmount: perSwapMatch[1],
    };
  }

  const loopHoursMatch =
    trimmed.match(/\b(?:every|each)\s+(\d+(?:\.\d+)?)\s*hours?\b/i) ??
    trimmed.match(/\b(\d+(?:\.\d+)?)\s*hours?\s+(?:not\s+)?blocks?\b/i);
  if (loopHoursMatch) {
    next = {
      ...next,
      loopIntervalValue: loopHoursMatch[1],
      loopIntervalUnit: "hours",
    };
  }

  return next;
}

/** Extract follow-up answers (price, deposit amount, token) when the LLM misses them. */
export function applyFollowUpHeuristics(parsed: ParsedPrompt, prompt: string): ParsedPrompt {
  const trimmed = prompt.trim();
  const next = inferDualAmounts(parsed, prompt);

  if (next.swapAmount && next.amount) {
    return next;
  }

  const amountToken = trimmed.match(AMOUNT_TOKEN_PATTERN);
  const tokenAmount = trimmed.match(TOKEN_AMOUNT_PATTERN);

  if (amountToken) {
    if (next.useLoop && /\b(?:swap|per|each|use)\b/i.test(trimmed)) {
      next.swapAmount = amountToken[1];
    } else {
      next.amount = amountToken[1];
    }
    next.coin = normalizeToken(amountToken[2]) ?? next.coin;
  } else if (tokenAmount) {
    next.coin = normalizeToken(tokenAmount[1]) ?? next.coin;
    if (next.useLoop && /\b(?:swap|per|each|use)\b/i.test(trimmed)) {
      next.swapAmount = tokenAmount[2];
    } else {
      next.amount = tokenAmount[2];
    }
  } else {
    const depositOnly = trimmed.match(/\bdeposit\s+(\d+(?:\.\d+)?)\b/i);
    if (depositOnly) {
      next.amount = depositOnly[1];
      next.coin = next.coin ?? "USDC";
    }
  }

  if (/\bdeposit\s+(eth|usdc)\b/i.test(trimmed)) {
    const token = trimmed.match(TOKEN_PATTERN);
    if (token) next.coin = normalizeToken(token[1]) ?? next.coin;
  }

  if (/\b(?:swap|buy|use|spend)\s+(?:for\s+)?all\b/i.test(trimmed)) {
    next.side = next.side ?? "buy";
    next.includeSwap = true;
  }

  const priceHint = trimmed.match(/\b(?:make it|target|at|price)\s+(\d+(?:\.\d+)?)\b/i);
  if (priceHint) {
    next.priceGoal = priceHint[1];
  } else if (/^\s*\d+(?:\.\d+)?\s*(?:usdc|usd|\$)?\s*$/i.test(trimmed)) {
    next.priceGoal = trimmed.match(/(\d+(?:\.\d+)?)/)?.[1] ?? next.priceGoal;
  }

  if (/\b(?:also|change|switch)\b/i.test(trimmed) && TOKEN_PATTERN.test(trimmed)) {
    const token = trimmed.match(TOKEN_PATTERN);
    if (token && /\bdeposit\b/i.test(trimmed)) {
      next.coin = normalizeToken(token[1]) ?? next.coin;
    }
  }

  if (next.coin === "USDC" && next.side === "buy" && !next.toCoin) {
    next.toCoin = "ETH";
    next.includeSwap = true;
  }

  return next;
}
