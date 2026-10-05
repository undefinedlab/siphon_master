import { extractDexFromText, isActiveToken, normalizeDex, normalizeToken } from "./blocks";
import type { MissingField, ParsedPrompt, StrategySide } from "./types";

const TOKEN_PATTERN = /\b(eth|usdc|usdt|wbtc|sol|xmr)\b/i;
const WALLET_PATTERN = /0x[a-fA-F0-9]{40}/;
const NUMBER_PATTERN = /\d+(?:\.\d+)?/;

function extractToken(answer: string): string | null {
  const match = answer.match(TOKEN_PATTERN);
  return match ? normalizeToken(match[1]) : normalizeToken(answer.trim());
}

function parseSide(answer: string): StrategySide | null {
  const lower = answer.toLowerCase();
  if (/\b(buy|long)\b/.test(lower)) return "buy";
  if (/\b(sell|short)\b/.test(lower)) return "sell";
  return null;
}

export function applyFollowUpAnswer(
  field: MissingField,
  answer: string,
  parsed: ParsedPrompt
): ParsedPrompt {
  const trimmed = answer.trim();
  const next: ParsedPrompt = { ...parsed };

  switch (field) {
    case "coin":
    case "inactiveToken": {
      const token = extractToken(trimmed);
      if (token && (field === "inactiveToken" ? isActiveToken(token) : true)) {
        next.coin = token;
      }
      break;
    }
    case "amount": {
      const match = trimmed.match(NUMBER_PATTERN);
      if (match) next.amount = match[0];
      break;
    }
    case "side": {
      const side = parseSide(trimmed);
      if (side) next.side = side;
      break;
    }
    case "priceGoal":
    case "rangeLow":
    case "rangeHigh":
    case "gridLevels":
    case "sliceCount":
    case "intervalSeconds": {
      const match = trimmed.match(NUMBER_PATTERN);
      if (match) next[field] = match[0];
      break;
    }
    case "loopInterval": {
      const everyMatch = trimmed.match(
        /every\s+(\d+)\s*(blocks?|seconds?|minutes?|hours?|h|d|days?)/i
      );
      if (everyMatch) {
        next.loopIntervalValue = everyMatch[1];
        const unit = everyMatch[2].toLowerCase();
        if (unit.startsWith("h")) next.loopIntervalUnit = "hours";
        else if (unit.startsWith("m") || unit.startsWith("min")) next.loopIntervalUnit = "minutes";
        else if (unit.startsWith("b")) next.loopIntervalUnit = "blocks";
        else next.loopIntervalUnit = "seconds";
      } else {
        const match = trimmed.match(NUMBER_PATTERN);
        if (match) next.loopIntervalValue = match[0];
      }
      break;
    }
    case "toCoin": {
      const token = extractToken(trimmed);
      if (token) next.toCoin = token;
      break;
    }
    case "dex": {
      const dex = normalizeDex(trimmed) ?? extractDexFromText(trimmed);
      if (dex) next.dex = dex;
      break;
    }
    case "wallet": {
      const walletMatch = trimmed.match(WALLET_PATTERN);
      if (walletMatch) next.wallet = walletMatch[0];
      break;
    }
    case "polyMarket": {
      if (trimmed) {
        next.polyMarketQuery = trimmed;
        // New market description invalidates any previously resolved market.
        next.polyTokenId = null;
        next.polyMarketId = null;
        next.polyMarketQuestion = null;
        next.polyOdds = null;
        next.polyOutcomes = null;
      }
      break;
    }
    case "polyOutcome": {
      const fromList = parsed.polyOutcomes?.find((o) =>
        trimmed.toLowerCase().includes(o.toLowerCase()),
      );
      const outcome = fromList ?? (trimmed || null);
      if (outcome) {
        next.polyOutcome = outcome;
        // Token id is per-outcome — force re-resolution against the new outcome.
        next.polyTokenId = null;
      }
      break;
    }
  }

  next.raw = `${parsed.raw}\n${trimmed}`.trim();
  return next;
}

export function applyIntentFromMessage(
  message: string,
  parsed: ParsedPrompt
): ParsedPrompt {
  const walletMatch = message.match(WALLET_PATTERN);
  const side = parseSide(message);

  const namedDex = extractDexFromText(message);
  const includeSwap =
    parsed.includeSwap ||
    /\b(swap|convert|exchange)\b/i.test(message) ||
    Boolean(namedDex);
  const earnExit = /\b(exit\s+earn|redeem\s+jl|withdraw\s+from\s+earn)\b/i.test(message);
  const earnEnter =
    /\b(earn|lend|jupiter\s+earn|supply\s+usdc|jlusdc)\b/i.test(message) && !earnExit;
  const includeLend = parsed.includeLend || earnEnter || earnExit;

  return {
    ...parsed,
    side: parsed.side ?? side,
    dex: parsed.dex ?? namedDex,
    includeSwap,
    includeLend,
    lendAction: includeLend
      ? earnExit
        ? "exit"
        : parsed.lendAction ?? "enter"
      : parsed.lendAction,
    includeWithdraw:
      parsed.includeWithdraw ||
      /\b(withdraw|send\s+to)\b/i.test(message) ||
      (/\bwallet\b/i.test(message) && Boolean(walletMatch)),
    wallet: parsed.wallet ?? walletMatch?.[0] ?? null,
  };
}

export function mergeParsed(
  base: ParsedPrompt,
  patch: Partial<ParsedPrompt>
): ParsedPrompt {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== null && value !== undefined)
    ),
  } as ParsedPrompt;
}
