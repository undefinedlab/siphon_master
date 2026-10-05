import { NextRequest, NextResponse } from "next/server";
import { buildBuilderLlmSystemPrompt } from "@/builder_agent/builderContext";
import { stripInternalArmCopy } from "@/builder_agent/stripArmCopy";
import { resolveMarketPricesUsd, type MarketPricesUsd } from "@/lib/fetchEthUsd";
import { gatePrivilegedProxy } from "@/lib/privilegedProxyGate";
import { isProductionRuntime, isRateLimited } from "@/lib/graphHttpGuard";

export const runtime = "nodejs";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Default free model — override with OPENROUTER_MODEL on Vercel. */
const DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

function getApiKey(): string | null {
  let key =
    process.env.OPENROUTER_API_KEY?.trim() ||
    process.env.OPENROUTER_KEY?.trim() ||
    "";
  if (!key) return null;
  if (key.toLowerCase().startsWith("bearer ")) {
    key = key.slice(7).trim();
  }
  return key || null;
}

function getReferer(): string {
  return (
    process.env.OPENROUTER_SITE_URL?.trim() ||
    process.env.VERCEL_URL?.trim() ||
    "https://siphon-app.vercel.app"
  ).replace(/^(?!https?:\/\/)/, "https://");
}

function parseOpenRouterError(status: number, errText: string): string {
  try {
    const body = JSON.parse(errText) as { error?: { message?: string; code?: number } };
    const msg = body.error?.message?.trim();
    if (msg) return `OpenRouter ${status}: ${msg}`;
  } catch {
    /* not json */
  }
  const snippet = errText.trim().slice(0, 200);
  return snippet ? `OpenRouter ${status}: ${snippet}` : `OpenRouter HTTP ${status}`;
}

function getModel(): string {
  return process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
}

function extractJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim()) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildSystemPrompt(
  currentState?: Record<string, unknown>,
  marketPrices?: MarketPricesUsd,
): string {
  const chainId =
    typeof currentState?.chainId === "number" ? currentState.chainId : undefined;
  const homeChainId =
    typeof currentState?.homeChainId === "string" ? currentState.homeChainId : undefined;
  const parts = [buildBuilderLlmSystemPrompt({ chainId, homeChainId })];

  if (marketPrices?.ETH != null && marketPrices.ETH > 0) {
    parts.push(`
<market_prices_usd>
${JSON.stringify(marketPrices, null, 2)}
</market_prices_usd>`);
  }

  if (currentState && Object.keys(currentState).length > 0) {
    parts.push(`
<current_flow_state>
${JSON.stringify(currentState, null, 2)}
</current_flow_state>`);
  }

  return parts.join("\n");
}

export async function POST(req: NextRequest) {
  const cluster = (process.env.NEXT_PUBLIC_CLUSTER || process.env.CLUSTER || "")
    .trim()
    .toLowerCase();
  const allowUnsignedDevnet =
    cluster === "devnet" ||
    cluster === "local" ||
    (process.env.BUILDER_AGENT_ALLOW_UNSIGNED || "").trim() === "1";

  let gated: Awaited<ReturnType<typeof gatePrivilegedProxy>>;
  if (allowUnsignedDevnet) {
    // Solana Devnet / Phantom-only: OpenRouter is still server-side; auth is IP rate-limit only.
    const originDeny = (await import("@/lib/apiWalletAuth")).assertBrowserSameOrigin(req);
    if (originDeny) {
      return NextResponse.json(originDeny.body, { status: originDeny.status });
    }
    let bodyText = "";
    try {
      bodyText = await req.text();
    } catch {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
    const { clientKeyFromRequest, isRateLimited } = await import("@/lib/graphHttpGuard");
    const max = Number(process.env.BUILDER_AGENT_RATE_MAX || "10");
    const ip = clientKeyFromRequest(req);
    if (isRateLimited(`builder-agent:${ip}`, max)) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    gated = { ok: true, wallet: "optional", bodyText };
  } else {
    gated = await gatePrivilegedProxy(req, {
      bucket: "builder-agent",
      max: Number(process.env.BUILDER_AGENT_RATE_MAX || "10"),
    });
  }
  if (!gated.ok) return gated.response;

  // Per-wallet daily soft cap (in-memory — secondary to wallet auth TTL).
  const dayKey = `builder-day:${gated.wallet}:${new Date().toISOString().slice(0, 10)}`;
  const dayMax = Number(process.env.BUILDER_AGENT_DAILY_MAX || "40");
  if (gated.wallet && gated.wallet !== "optional" && isRateLimited(dayKey, dayMax, Date.now(), 86_400_000)) {
    return NextResponse.json({ error: "builder_daily_limit" }, { status: 429 });
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: "llm_unconfigured" }, { status: 501 });
  }

  let body: {
    prompt?: string;
    transcript?: string[];
    chatHistory?: Array<{ role?: string; content?: string }>;
    currentState?: Record<string, unknown>;
    marketPrices?: Partial<{ ETH: number | null; USDC: number }>;
  };
  try {
    body = JSON.parse(gated.bodyText || "{}") as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  const maxPrompt = Number(process.env.BUILDER_AGENT_MAX_PROMPT || "8000");
  if (prompt.length > maxPrompt) {
    return NextResponse.json({ error: "prompt_too_large" }, { status: 413 });
  }

  const chatHistory = Array.isArray(body.chatHistory)
    ? body.chatHistory
        .filter(
          (turn): turn is { role: "user" | "assistant"; content: string } =>
            (turn.role === "user" || turn.role === "assistant") &&
            typeof turn.content === "string" &&
            turn.content.trim() !== "",
        )
        .slice(-10)
    : [];

  const legacyTranscript = Array.isArray(body.transcript) ? body.transcript.slice(-6) : [];
  const fallbackHistory =
    chatHistory.length > 0
      ? chatHistory
      : legacyTranscript.map((content) => ({ role: "user" as const, content }));

  const currentState =
    body.currentState && typeof body.currentState === "object" ? body.currentState : undefined;

  const marketPrices = await resolveMarketPricesUsd(body.marketPrices);

  const apiMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: buildSystemPrompt(currentState, marketPrices) },
    ...fallbackHistory.flatMap((turn) => {
      const content = turn.role === "assistant" ? stripInternalArmCopy(turn.content) : turn.content;
      if (!content.trim()) return [];
      return [{ role: turn.role, content }];
    }),
  ];

  if (
    fallbackHistory.length === 0 ||
    fallbackHistory[fallbackHistory.length - 1]?.content.trim() !== prompt
  ) {
    apiMessages.push({ role: "user", content: prompt });
  }

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": getReferer(),
        "X-Title": process.env.OPENROUTER_APP_NAME?.trim() || "Siphon Builder",
      },
      body: JSON.stringify({
        model: getModel(),
        // A reasoning model spends this budget on thinking before it writes anything, and
        // returns EMPTY content when it runs out — deepseek-v4-flash burned 982 of 1024
        // tokens reasoning and emitted nothing, which surfaced as "Something went wrong".
        // We only want the JSON object, never the chain of thought, so turn reasoning off;
        // models that have none ignore the field. The raised ceiling is the backstop for a
        // model that ignores the flag — unused tokens are not billed, so it costs nothing.
        reasoning: { enabled: false },
        max_tokens: 4096,
        temperature: 0.2,
        messages: apiMessages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      const detail = parseOpenRouterError(response.status, errText);
      console.error("[builder-agent]", detail);
      // Do not leak upstream vendor/account errors to the browser in production (PROXY-06).
      const clientDetail = isProductionRuntime()
        ? "LLM upstream error"
        : detail;
      return NextResponse.json(
        { error: "openrouter_error", detail: clientDetail },
        { status: 502 },
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const choice = payload.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      // Name the cause rather than just "empty". finish_reason="length" with reasoning
      // tokens spent means the model thought past its budget — raise max_tokens or turn
      // reasoning off for it, don't go hunting for a parser bug.
      console.error(
        `[builder-agent] empty content from ${getModel()} ` +
          `(finish_reason=${choice?.finish_reason ?? "?"}, ` +
          `reasoning_tokens=${payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0})`,
      );
      return NextResponse.json({ error: "empty_response" }, { status: 502 });
    }

    const input = extractJson(content);
    if (!input) {
      console.error("[builder-agent] Failed to parse JSON:", content.slice(0, 400));
      return NextResponse.json({ error: "invalid_llm_json" }, { status: 502 });
    }

    const { message, intent, ...parsed } = input;
    const resolvedIntent = intent === "build" ? "build" : "advise";
    const rawMessage = typeof message === "string" ? message : "";
    const resolvedMessage = stripInternalArmCopy(rawMessage) || null;

    return NextResponse.json({
      parsed: resolvedIntent === "build" ? parsed : {},
      message: resolvedMessage,
      intent: resolvedIntent,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "llm_error";
    console.error("[builder-agent] LLM error:", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
