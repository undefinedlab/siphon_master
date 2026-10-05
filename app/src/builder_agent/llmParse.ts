import { clampParsedToSupportedFlow } from "./flowCapabilities";
import { applyIntentFromMessage } from "./parseFollowUp";
import {
  augmentParsedFromPrompt,
  applyFixedEthLoopBuy,
  applyFollowUpHeuristics,
  applyPercentDipPrice,
  applyPercentTakeProfitPrice,
} from "./inferToolsFromPrompt";
import { mergeLlmOntoParsed, parsedToFlowSnapshot } from "./mergeLlmParsed";
import { applyPipelineHopsToParsed } from "./pipelineHops";
import {
  getDefaultAdvisorMessage,
  resolveTurnIntent,
  type BuilderMessageIntent,
} from "./messageIntent";
import { createDefaultParsed } from "./parsedDefaults";
import { applyPredictionsResolution } from "./resolvePolymarket";
import type { BuilderAgentSession, ParsedPrompt } from "./types";

export interface BuilderChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface BuilderMarketContext {
  ethUsd: number | null;
  /** Selected canvas chain — drives Graph assess (defaults to Base if omitted). */
  chainId?: number;
  /** Home-chain picker id (solana-mainnet / solana-devnet / …). */
  homeChainId?: string | null;
}

export interface LlmParseResult {
  parsed: ParsedPrompt;
  message: string | null;
  intent: BuilderMessageIntent;
}

export type LlmParseFailure =
  | { ok: false; reason: "unconfigured" }
  | { ok: false; reason: "openrouter_error"; detail?: string }
  | { ok: false; reason: "bad_response" }
  | { ok: false; reason: "network" }
  | { ok: false; reason: "wallet_required" };

function isDevnetBuilderCluster(): boolean {
  const c = (process.env.NEXT_PUBLIC_CLUSTER || "").trim().toLowerCase();
  return c === "devnet" || c === "local";
}

export function isLlmParseFailure(
  result: LlmParseResult | LlmParseFailure,
): result is LlmParseFailure {
  return "ok" in result && result.ok === false;
}

/**
 * Calls /api/builder-agent (OpenRouter) and merges JSON onto prior session state.
 */
export async function llmParse(
  prompt: string,
  chatHistory: BuilderChatTurn[],
  previousParsed?: ParsedPrompt | null,
  market?: BuilderMarketContext,
  session?: BuilderAgentSession | null,
): Promise<LlmParseResult | LlmParseFailure> {
  const chainOpts = {
    chainId: market?.chainId,
    homeChainId: market?.homeChainId,
  };
  const base =
    previousParsed ??
    createDefaultParsed(chatHistory.map((t) => t.content).join("\n") || prompt, undefined, chainOpts);

  const ethUsd = market?.ethUsd ?? null;

  let data: {
    parsed?: Record<string, unknown>;
    message?: string | null;
    intent?: string;
    error?: string;
    detail?: string;
  };
  const stateExtras =
    market?.chainId != null || market?.homeChainId
      ? { chainId: market?.chainId, homeChainId: market?.homeChainId ?? undefined }
      : undefined;
  const payload = JSON.stringify({
    prompt,
    chatHistory: chatHistory.slice(-10),
    currentState: previousParsed
      ? parsedToFlowSnapshot(previousParsed, stateExtras)
      : stateExtras,
    marketPrices: { ETH: ethUsd, USDC: 1 },
  });

  try {
    const { getSigner } = await import("@/lib/nexus");
    const { fetchWithWalletAuth } = await import("@/lib/walletAuthHeaders");
    const signer = getSigner();
    let res: Response;
    if (signer) {
      // Production / EVM: privileged wallet-bound auth (protects OpenRouter key).
      res = await fetchWithWalletAuth(signer, "/api/builder-agent", {
        method: "POST",
        body: payload,
      });
    } else if (isDevnetBuilderCluster()) {
      // Solana Devnet / Phantom-only: no EVM signer — unsigned call (server rate-limits by IP).
      res = await fetch("/api/builder-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
    } else {
      return { ok: false, reason: "wallet_required" };
    }
    data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 501 || data.error === "llm_unconfigured") {
        return { ok: false, reason: "unconfigured" };
      }
      if (data.error === "openrouter_error") {
        return { ok: false, reason: "openrouter_error", detail: data.detail };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: "wallet_required" };
      }
      return { ok: false, reason: "bad_response" };
    }
  } catch {
    return { ok: false, reason: "network" };
  }

  const llmIntent = data.intent === "build" ? "build" : "advise";
  const intent = resolveTurnIntent(llmIntent, session ?? null, prompt);

  if (intent === "advise") {
    return {
      parsed: base,
      message:
        (typeof data.message === "string" && data.message.trim()) ||
        getDefaultAdvisorMessage(prompt),
      intent,
    };
  }

  const llm = data.parsed ?? {};

  let parsed = mergeLlmOntoParsed(base, llm, prompt, chainOpts);

  // Predictions: skip the ETH/swap-centric heuristics (dip %, take-profit %, USDC→ETH toCoin
  // injection) — they'd corrupt a bet parse — and resolve the market to a CLOB token id instead.
  if (parsed.strategy === "Predictions") {
    const { parsed: resolved, note } = await applyPredictionsResolution(parsed);
    const llmMessage = typeof data.message === "string" ? data.message : null;
    return {
      parsed: resolved,
      message: [llmMessage, note].filter(Boolean).join("\n") || null,
      intent: "build",
    };
  }

  parsed = augmentParsedFromPrompt(parsed, prompt);
  parsed = applyFollowUpHeuristics(parsed, prompt);
  parsed = applyPercentDipPrice(parsed, prompt, ethUsd);
  parsed = applyPercentTakeProfitPrice(parsed, prompt, ethUsd);
  parsed = applyFixedEthLoopBuy(parsed, prompt, ethUsd);
  parsed = applyIntentFromMessage(prompt, parsed);
  parsed = applyPipelineHopsToParsed(parsed, prompt);

  const { parsed: clamped, capabilityMessage } = clampParsedToSupportedFlow(parsed, prompt);

  const llmMessage = typeof data.message === "string" ? data.message.trim() : "";
  const llmTruncated =
    /not supported as one flow|focus on the first|only phase 1|let'?s focus on/i.test(llmMessage);
  const pipelineMsg =
    clamped.pipelineHops && clamped.pipelineHops.length >= 2
      ? `Built a private ${clamped.pipelineHops.length}-hop pipeline on Solana Devnet: ${clamped.pipelineHops
          .map((h) => `${h.assetIn}→${h.assetOut}`)
          .join(" → ")}. TEE proves each hop after the prior return.`
      : null;

  return {
    parsed: clamped,
    message:
      capabilityMessage ??
      (pipelineMsg && (llmTruncated || !llmMessage) ? pipelineMsg : llmMessage || pipelineMsg),
    intent: "build",
  };
}