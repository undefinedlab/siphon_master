import type { Edge, Node } from "@xyflow/react";
import { createFlowFromParsed } from "./createNodes";
import { llmParse, isLlmParseFailure, type BuilderChatTurn, type BuilderMarketContext, type LlmParseFailure } from "./llmParse";
import {
  getDefaultAdvisorMessage,
  shouldMaterializeFlow,
} from "./messageIntent";
import { createDefaultParsed } from "./parsedDefaults";
import { getNextQuestion } from "./questions";
import { syncFlowStructure } from "./syncFlow";
import type { BuilderAgentSession, BuilderAgentTurnResult, ParsedPrompt } from "./types";

const LLM_MESSAGES: Record<LlmParseFailure["reason"], string> = {
  unconfigured:
    "Builder AI is not configured. Set OPENROUTER_API_KEY on the server (Railway / .env.local) and redeploy.",
  openrouter_error:
    "AI rejected the request. Check the model/key and try again.",
  bad_response: "Something went wrong, please try again.",
  network: "Could not reach the server. Check your connection and try again.",
  wallet_required:
    "Connect an EVM wallet (MetaMask / Rainbow) to use Builder AI, or use Solana Devnet mode where unsigned Builder is allowed.",
};

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

/** OpenRouter-backed builder turn (sole active agent path). */
export async function processBuilderTurn(
  input: string,
  session: BuilderAgentSession | null,
  existingNodes: Node[],
  existingEdges: Edge[],
  chatHistory: BuilderChatTurn[] = [],
  market?: BuilderMarketContext,
): Promise<BuilderAgentTurnResult> {
  const trimmed = input.trim();
  const transcript = [...(session?.transcript ?? []), trimmed];

  const result = await llmParse(trimmed, chatHistory, session?.parsed ?? null, market, session);
  if (isLlmParseFailure(result)) {
    const botMessage =
      result.reason === "openrouter_error" && result.detail
        ? result.detail
        : LLM_MESSAGES[result.reason];
    return {
      nodes: existingNodes,
      edges: existingEdges,
      session: session ?? buildSession(createDefaultParsed(trimmed), [trimmed]),
      botMessage,
    };
  }

  const { parsed, intent } = result;
  const materialize = shouldMaterializeFlow(intent, parsed, existingNodes.length);

  if (!materialize) {
    const keptParsed =
      intent === "build"
        ? parsed
        : session?.parsed ?? createDefaultParsed(trimmed);
    return {
      nodes: existingNodes,
      edges: existingEdges,
      session: buildSession(keptParsed, transcript),
      botMessage:
        result.message ??
        (intent === "advise" ? getDefaultAdvisorMessage(trimmed) : getNextQuestion(parsed)?.question ?? null),
    };
  }

  const { nodes, edges } = applyFlowFromParsed(parsed, existingNodes, existingEdges);
  const nextSession = buildSession(parsed, transcript);
  const botMessage = result.message ?? getNextQuestion(parsed)?.question ?? null;

  return { nodes, edges, session: nextSession, botMessage };
}
