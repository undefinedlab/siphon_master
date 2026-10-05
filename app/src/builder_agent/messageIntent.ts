import type { BuilderAgentSession, ParsedPrompt } from "./types";

export type BuilderMessageIntent = "build" | "advise";

/** True when the parsed state has enough signal to place blocks on an empty canvas. */
export function hasConcreteBuildSignal(parsed: ParsedPrompt): boolean {
  return Boolean(
    parsed.coin ||
      parsed.amount ||
      parsed.toCoin ||
      parsed.polyMarketQuery ||
      parsed.priceGoal ||
      parsed.rangeLow ||
      parsed.wallet ||
      parsed.useLoop ||
      parsed.includeSchedule ||
      parsed.includeSwap ||
      parsed.includeWithdraw,
  );
}

/** Follow-up answers to a missing-field question should always continue building. */
export function isBuildFollowUp(
  message: string,
  session: BuilderAgentSession | null,
): boolean {
  return Boolean(session?.pendingField);
}

export function resolveTurnIntent(
  llmIntent: BuilderMessageIntent | null | undefined,
  session: BuilderAgentSession | null,
  message: string,
): BuilderMessageIntent {
  if (isBuildFollowUp(message, session)) return "build";
  return llmIntent === "build" ? "build" : "advise";
}

export function shouldMaterializeFlow(
  intent: BuilderMessageIntent,
  parsed: ParsedPrompt,
  existingNodeCount: number,
): boolean {
  if (intent !== "build") return false;
  if (existingNodeCount > 0) return true;
  return hasConcreteBuildSignal(parsed);
}

export function getDefaultAdvisorMessage(message: string): string {
  const trimmed = message.trim().toLowerCase();

  if (/^(hi|hello|hey|yo|sup|howdy|greetings|good\s+(morning|afternoon|evening))\b/.test(trimmed)) {
    return "Hey — I'm your Siphon strategy advisor. I can explain DeFi concepts, suggest approaches, or build a private flow on the canvas when you're ready. What are you trying to do — DCA, limit buy, take profit, something else?";
  }

  if (/^help\b/.test(trimmed)) {
    return "I'm here to help. Ask me how a strategy works, what Siphon can do, or describe a flow in plain English (e.g. \"deposit 500 USDC and DCA into ETH every 24 hours\") and I'll build it on the canvas.";
  }

  if (/^(thanks|thank you|thx)\b/.test(trimmed)) {
    return "You're welcome. Tell me when you want to tweak the flow or try another strategy.";
  }

  return "Happy to help. Ask a DeFi question or describe the strategy you want to run — I'll guide you or build it on the canvas when you're ready.";
}
