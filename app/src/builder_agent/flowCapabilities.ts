import type { ParsedPrompt } from "./types";
import { isSolanaVenuePipelinePrompt } from "./pipelineHops";

const MULTI_PHASE_PATTERNS = [
  /\b(?:two|2)[\s-]?loops?\b/i,
  /\bphase\s+[12]\b/i,
  /\(\s*1\s*\)[\s\S]+\(\s*2\s*\)/i,
  /\bonce\s+.+\s+(?:is\s+)?empty[,\s]+(?:then|switch|sell|start)/i,
  /\bwhile\s+.+\s+(?:remains|left)[;\s,]+(?:once|then|after|when)/i,
  /\bfirst[\s,]+.+[\s,]+(?:then|once|after that|second)/i,
];

const SECOND_PHASE_HINT =
  /\b(then|once\s+.+\s+empty|;\s*\(2\)|phase\s+2|\(2\)|second\s+loop|second\s+phase)\b/i;

/**
 * User described sequential DCA/loop phases the canvas cannot express as one graph.
 * Solana venue pipelines (earn→swap→stake…) are NOT multi-phase in this sense — they are one PIPELINE.
 */
export function isMultiPhaseFlowPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  if (isSolanaVenuePipelinePrompt(trimmed)) return false;
  if (!MULTI_PHASE_PATTERNS.some((re) => re.test(trimmed))) return false;
  return SECOND_PHASE_HINT.test(trimmed);
}

const MULTI_PHASE_USER_MESSAGE =
  "Siphon supports one Loop per flow (Deposit → Loop → Swap). Multi-phase “once empty, then switch to…” flows can’t be one canvas yet — I built phase 1 (recurring buy until deposit token runs out). Create a second flow for the sell phase, or tell me which single phase to keep.";

export function clampParsedToSupportedFlow(
  parsed: ParsedPrompt,
  prompt: string
): { parsed: ParsedPrompt; capabilityMessage: string | null } {
  // Private multi-hop PIPELINE: keep sequential Earn / Swap / Stake hops intact.
  if (parsed.pipelineHops && parsed.pipelineHops.length >= 2) {
    return { parsed, capabilityMessage: null };
  }
  if (isSolanaVenuePipelinePrompt(prompt)) {
    return { parsed, capabilityMessage: null };
  }
  if (!isMultiPhaseFlowPrompt(prompt)) {
    return { parsed, capabilityMessage: null };
  }

  const clamped: ParsedPrompt = {
    ...parsed,
    useLoop: true,
    includeSwap: true,
    includeSchedule: parsed.includeSchedule,
    strategy: "Limit Order",
    priceGoal: null,
    side: parsed.side ?? "buy",
    toCoin: parsed.toCoin ?? "ETH",
    coin: parsed.coin ?? "USDC",
    loopIntervalValue: parsed.loopIntervalValue ?? "24",
    loopIntervalUnit: parsed.loopIntervalUnit ?? "hours",
    pipelineHops: null,
  };

  return { parsed: clamped, capabilityMessage: MULTI_PHASE_USER_MESSAGE };
}
