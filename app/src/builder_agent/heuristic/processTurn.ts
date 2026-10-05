import type { Edge, Node } from "@xyflow/react";
import { createFlowFromParsed } from "../createNodes";
import { applyFollowUpAnswer, applyIntentFromMessage, mergeParsed } from "../parseFollowUp";
import { parsePrompt } from "../parsePrompt";
import { getNextQuestion } from "../questions";
import { syncFlowStructure } from "../syncFlow";
import type { BuilderAgentSession, BuilderAgentTurnResult, ParsedPrompt } from "../types";

function buildSession(parsed: ParsedPrompt, transcript: string[]): BuilderAgentSession {
  const next = getNextQuestion(parsed);
  return {
    parsed,
    pendingField: next?.field ?? null,
    transcript,
  };
}

function applyFlowFromParsed(
  parsed: ParsedPrompt,
  existingNodes: Node[],
  existingEdges: Edge[],
): { nodes: Node[]; edges: Edge[] } {
  if (existingNodes.length === 0) {
    return createFlowFromParsed(parsed);
  }
  return syncFlowStructure(existingNodes, existingEdges, parsed);
}

/** Regex / keyword builder turn — only used when {@link HEURISTIC_AGENT_ENABLED} is true. */
export function processHeuristicTurn(
  input: string,
  session: BuilderAgentSession | null,
  existingNodes: Node[],
  existingEdges: Edge[],
): BuilderAgentTurnResult {
  const trimmed = input.trim();

  if (!session) {
    const parsed = parsePrompt(trimmed);
    const transcript = [trimmed];
    const { nodes, edges } = createFlowFromParsed(parsed);
    const nextSession = buildSession(parsed, transcript);
    const next = getNextQuestion(parsed);

    return {
      nodes,
      edges,
      session: nextSession,
      botMessage: next?.question ?? null,
    };
  }

  let parsed = { ...session.parsed };
  const transcript = [...session.transcript, trimmed];

  if (session.pendingField) {
    parsed = applyFollowUpAnswer(session.pendingField, trimmed, parsed);
  } else {
    const patch = parsePrompt(trimmed);
    parsed = mergeParsed(parsed, {
      coin: patch.coin,
      toCoin: patch.toCoin,
      amount: patch.amount,
      side: patch.side,
      priceGoal: patch.priceGoal,
      rangeLow: patch.rangeLow,
      rangeHigh: patch.rangeHigh,
      gridLevels: patch.gridLevels,
      sliceCount: patch.sliceCount,
      intervalSeconds: patch.intervalSeconds,
      maxSlippageBps: patch.maxSlippageBps,
      wallet: patch.wallet,
      strategy: patch.strategy,
      useLoop: patch.useLoop || parsed.useLoop,
      loopIntervalValue: patch.loopIntervalValue ?? parsed.loopIntervalValue,
      loopIntervalUnit: patch.loopIntervalUnit ?? parsed.loopIntervalUnit,
      includeSchedule: patch.includeSchedule || parsed.includeSchedule,
      scheduleValue: patch.scheduleValue ?? parsed.scheduleValue,
      scheduleUnit: patch.scheduleUnit ?? parsed.scheduleUnit,
      includeSwap: patch.includeSwap || parsed.includeSwap,
      includeWithdraw: patch.includeWithdraw || parsed.includeWithdraw,
    });
    parsed.raw = `${parsed.raw}\n${trimmed}`.trim();
  }

  parsed = applyIntentFromMessage(trimmed, parsed);

  const { nodes, edges } = applyFlowFromParsed(parsed, existingNodes, existingEdges);
  const nextSession = buildSession(parsed, transcript);
  const next = getNextQuestion(parsed);

  return {
    nodes,
    edges,
    session: nextSession,
    botMessage: next?.question ?? null,
  };
}
