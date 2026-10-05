import { isActiveToken } from "../blocks";
import { createFlowFromParsed } from "../createNodes";
import { parsePrompt } from "../parsePrompt";
import { getMissingFields } from "../questions";
import type { BuilderAgentResult, ParsedPrompt } from "../types";

function collectWarnings(parsed: ParsedPrompt): string[] {
  return getMissingFields(parsed).map((field) => {
    switch (field) {
      case "coin":
        return "No input token detected — pick a coin on the Deposit block.";
      case "inactiveToken":
        return `${parsed.coin} is not active yet — switch to ETH or USDC before running.`;
      case "amount":
        return "No amount detected — set an amount on the Deposit block.";
      case "side":
        return "Limit order side not set — choose buy or sell on the Strategy block.";
      case "priceGoal":
        return "No trigger price detected — set it on the Strategy block.";
      case "rangeLow":
        return "Range low price not set — add it on the Strategy block.";
      case "rangeHigh":
        return "Range high price not set — add it on the Strategy block.";
      case "gridLevels":
        return "Grid level count not set — add it on the Strategy block.";
      case "sliceCount":
        return "TWAP slice count not set — add it on the Strategy block.";
      case "intervalSeconds":
        return "TWAP interval not set — add seconds between slices on the Strategy block.";
      case "loopInterval":
        return "Loop cadence not set — set interval on the Loop block.";
      case "toCoin":
        return "Swap requested but output token is unclear — set a To coin on the Swap block.";
      case "wallet":
        return "Withdraw block added but no wallet address found — add a recipient wallet.";
      default:
        return "Additional details needed.";
    }
  });
}

function buildSummary(parsed: ParsedPrompt, blockCount: number): string {
  if (parsed.pipelineHops && parsed.pipelineHops.length >= 2) {
    const path = parsed.pipelineHops.map((h) => `${h.assetIn}→${h.assetOut}`).join(" → ");
    return `Built private ${parsed.pipelineHops.length}-hop pipeline (${blockCount} blocks): ${path}.`;
  }
  if (parsed.useLoop) {
    const parts = [
      `${parsed.amount ?? "?"} ${parsed.coin ?? "token"}`,
      `loop every ${parsed.loopIntervalValue ?? "?"} ${parsed.loopIntervalUnit ?? "hours"}`,
    ];
    if (parsed.includeSwap && parsed.toCoin) parts.push(`swap to ${parsed.toCoin}`);
    if (parsed.includeWithdraw) {
      parts.push(parsed.wallet ? "withdraw to wallet" : "withdraw (wallet needed)");
    }
    return `Built recurring flow (${blockCount} blocks): ${parts.join(" → ")}.`;
  }

  const parts = [
    parsed.strategy,
    parsed.coin ? `${parsed.amount ?? "?"} ${parsed.coin}` : "unsized deposit",
  ];

  if (parsed.includeSwap && parsed.toCoin) {
    parts.push(`swap to ${parsed.toCoin}`);
  }

  if (parsed.includeWithdraw) {
    parts.push(parsed.wallet ? "withdraw to wallet" : "withdraw (wallet needed)");
  }

  return `Built ${blockCount}-block flow: ${parts.join(" → ")}.`;
}

/** One-shot regex flow generation — heuristic only. */
export function generateFlowFromPrompt(prompt: string): BuilderAgentResult {
  const parsed = parsePrompt(prompt);
  const { nodes, edges } = createFlowFromParsed(parsed);
  const warnings = collectWarnings(parsed);

  if (parsed.coin && !isActiveToken(parsed.coin) && !warnings.some((w) => w.includes("is not active"))) {
    warnings.unshift(`${parsed.coin} is not active yet — switch to ETH or USDC before running.`);
  }

  return {
    nodes,
    edges,
    warnings,
    summary: buildSummary(parsed, nodes.length),
  };
}
