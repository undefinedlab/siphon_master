/**
 * Private multi-hop PIPELINE hops inferred from the Builder prompt / canvas.
 *
 * Solana Devnet venues (jupiter-earn, meteora-dlmm, jito-stake) chain as one TEE-proved
 * pipeline. Bridge / EVM steps may trail on the canvas but are not hop rows.
 */
import type { Node } from "@xyflow/react";
import type { PipelineHopSpec } from "@/lib/chains/solanaDevnetStrategy";
import type { ParsedPrompt } from "./types";

export type PipelineHopParsed = {
  /** Canvas block: lend (Earn or Jito stake), or swap (Meteora). */
  kind: "lend" | "swap";
  /** Earn / stake action. */
  action?: "enter" | "exit";
  /** jupiter = Earn, jito = liquid stake, meteora = DLMM swap. */
  venue?: "jupiter" | "jito" | "meteora";
  assetIn: string;
  assetOut: string;
};

const VENUE_SEQ =
  /\b(?:lend|earn|yield|jl\s*usdc|julusdc|stake|jito|swap|meteora|liquid)\b/i;

/** True when the user asked for sequential Solana venue hops (not a DCA “once empty then sell” loop). */
export function isSolanaVenuePipelinePrompt(prompt: string): boolean {
  const t = prompt.trim();
  if (!t) return false;
  const hasEarn = /\b(?:earn|lend|yield|jl\s*usdc|julusdc|jupiter\s*earn)\b/i.test(t);
  const hasStake = /\b(?:stake|jito|liquid\s*stak)\b/i.test(t);
  const hasSwap = /\bswap\b/i.test(t);
  const hopCount = [hasEarn, hasStake, hasSwap].filter(Boolean).length;
  if (hopCount < 2) return false;
  // Exclude classic DCA multi-phase (“once empty then sell”) — those stay clamped.
  if (/\bonce\s+.+\s+empty\b/i.test(t) && /\b(?:then|switch)\b/i.test(t) && /\b(?:dca|every)\b/i.test(t)) {
    return false;
  }
  return VENUE_SEQ.test(t);
}

/**
 * Heuristic hop list for common Devnet routes when the LLM omits pipelineHops.
 * Earn → swap → stake → unwind is the screenshot path.
 */
export function inferPipelineHopsFromPrompt(prompt: string, amountHint?: string | null): PipelineHopParsed[] | null {
  if (!isSolanaVenuePipelinePrompt(prompt)) return null;
  const t = prompt.toLowerCase();
  const hops: PipelineHopParsed[] = [];

  const wantsEarn = /\b(?:earn|lend|yield|jl\s*usdc|julusdc)\b/.test(t);
  const wantsStake = /\b(?:stake|jito|liquid)\b/.test(t);
  const wantsJlToSol = wantsEarn && /\bswap\b/.test(t) && /\bsol\b/.test(t);
  const wantsLiquidToUsdc =
    wantsStake && /\bswap\b/.test(t) && /\busdc\b/.test(t);

  if (wantsEarn) {
    hops.push({
      kind: "lend",
      venue: "jupiter",
      action: "enter",
      assetIn: "USDC",
      assetOut: "jlUSDC",
    });
  }
  if (wantsJlToSol || (wantsEarn && wantsStake)) {
    hops.push({
      kind: "swap",
      venue: "meteora",
      assetIn: "jlUSDC",
      assetOut: "SOL",
    });
  }
  if (wantsStake) {
    hops.push({
      kind: "lend",
      venue: "jito",
      action: "enter",
      assetIn: "SOL",
      assetOut: "JitoSOL",
    });
  }
  if (wantsLiquidToUsdc) {
    // No direct JitoSOL↔USDC pool — unwind via SOL then USDC.
    hops.push({
      kind: "swap",
      venue: "meteora",
      assetIn: "JitoSOL",
      assetOut: "SOL",
    });
    hops.push({
      kind: "swap",
      venue: "meteora",
      assetIn: "SOL",
      assetOut: "USDC",
    });
  }

  void amountHint;
  return hops.length >= 2 ? hops : null;
}

export function normalizePipelineHops(raw: unknown): PipelineHopParsed[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const out: PipelineHopParsed[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = String(o.kind || "").toLowerCase();
    const assetIn = String(o.assetIn || o.asset_in || "").trim();
    const assetOut = String(o.assetOut || o.asset_out || "").trim();
    if (!assetIn || !assetOut) continue;
    if (kind === "swap") {
      out.push({
        kind: "swap",
        venue: "meteora",
        assetIn,
        assetOut,
      });
      continue;
    }
    if (kind === "lend" || kind === "stake") {
      const venueRaw = String(o.venue || (kind === "stake" ? "jito" : "jupiter")).toLowerCase();
      const venue = venueRaw === "jito" ? "jito" : "jupiter";
      const action = String(o.action || "enter").toLowerCase() === "exit" ? "exit" : "enter";
      out.push({ kind: "lend", venue, action, assetIn, assetOut });
    }
  }
  return out.length >= 2 ? out : null;
}

/** Map a canvas hop to an executor PipelineHopSpec (may expand one swap into two Meteora hops). */
export function pipelineHopToSpecs(h: PipelineHopParsed): PipelineHopSpec[] {
  if (h.kind === "lend") {
    if (h.venue === "jito") {
      return [
        {
          venue: "jito-stake",
          action: h.action === "exit" ? "exit" : "enter",
          assetIn: h.assetIn,
          assetOut: h.assetOut,
        },
      ];
    }
    return [
      {
        venue: "jupiter-earn",
        action: h.action === "exit" ? "exit" : "enter",
        assetIn: h.assetIn,
        assetOut: h.assetOut,
      },
    ];
  }
  const a = h.assetIn.toUpperCase().replace(/_/g, "");
  const b = h.assetOut.toUpperCase().replace(/_/g, "");
  // Direct pairs we support.
  if (
    (a === "JLUSDC" && (b === "SOL" || b === "WSOL")) ||
    ((a === "SOL" || a === "WSOL") && b === "JLUSDC")
  ) {
    return [{ venue: "meteora-dlmm", assetIn: h.assetIn, assetOut: h.assetOut, meteora_pair: "jlusdc_sol" }];
  }
  if (
    (a === "JITOSOL" && (b === "SOL" || b === "WSOL")) ||
    ((a === "SOL" || a === "WSOL") && b === "JITOSOL")
  ) {
    return [{ venue: "meteora-dlmm", assetIn: h.assetIn, assetOut: h.assetOut, meteora_pair: "jitosol_sol" }];
  }
  if (
    (a === "USDC" && (b === "SOL" || b === "WSOL")) ||
    ((a === "SOL" || a === "WSOL") && b === "USDC")
  ) {
    return [{ venue: "meteora-dlmm", assetIn: h.assetIn, assetOut: h.assetOut, meteora_pair: "usdc_sol" }];
  }
  // JitoSOL → USDC (or reverse): two hops via SOL.
  if (a === "JITOSOL" && b === "USDC") {
    return [
      { venue: "meteora-dlmm", assetIn: "JitoSOL", assetOut: "SOL", meteora_pair: "jitosol_sol" },
      { venue: "meteora-dlmm", assetIn: "SOL", assetOut: "USDC", meteora_pair: "usdc_sol" },
    ];
  }
  if (a === "USDC" && b === "JITOSOL") {
    return [
      { venue: "meteora-dlmm", assetIn: "USDC", assetOut: "SOL", meteora_pair: "usdc_sol" },
      { venue: "meteora-dlmm", assetIn: "SOL", assetOut: "JitoSOL", meteora_pair: "jitosol_sol" },
    ];
  }
  return [{ venue: "meteora-dlmm", assetIn: h.assetIn, assetOut: h.assetOut, meteora_pair: "usdc_sol" }];
}

export function flattenPipelineSpecs(hops: PipelineHopParsed[]): PipelineHopSpec[] {
  return hops.flatMap(pipelineHopToSpecs);
}

/** Deposit → … → final venue output for execution summary / graph plan. */
export function pipelinePathSummary(nodes: Node[]): {
  assetIn: string;
  assetOut: string;
  hops: PipelineHopParsed[];
  pathLabel: string;
} | null {
  const hops = pipelineHopsFromCanvas(nodes);
  if (hops.length < 2) return null;
  const assetIn = hops[0].assetIn;
  const assetOut = hops[hops.length - 1].assetOut;
  return {
    assetIn,
    assetOut,
    hops,
    pathLabel: hops.map((h) => `${h.assetIn}→${h.assetOut}`).join(" → "),
  };
}

/** Walk top-level lend/swap nodes left→right into pipeline hops. */
export function pipelineHopsFromCanvas(nodes: Node[]): PipelineHopParsed[] {
  const top = nodes
    .filter((n) => !n.parentId && (n.data?.type === "lend" || n.data?.type === "swap"))
    .sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0));
  const hops: PipelineHopParsed[] = [];
  for (const n of top) {
    const d = n.data as Record<string, unknown>;
    if (d.type === "lend") {
      const venue = String(d.lendVenue || "jupiter").toLowerCase() === "jito" ? "jito" : "jupiter";
      const action = String(d.lendAction || "enter").toLowerCase() === "exit" ? "exit" : "enter";
      hops.push({
        kind: "lend",
        venue,
        action,
        assetIn: String(d.coin || (venue === "jito" ? "SOL" : "USDC")),
        assetOut: String(d.toCoin || (venue === "jito" ? "JitoSOL" : "jlUSDC")),
      });
    } else {
      hops.push({
        kind: "swap",
        venue: "meteora",
        assetIn: String(d.coin || d.assetIn || "USDC"),
        assetOut: String(d.toCoin || d.assetOut || "SOL"),
      });
    }
  }
  return hops;
}

export function applyPipelineHopsToParsed(parsed: ParsedPrompt, prompt: string): ParsedPrompt {
  if (parsed.pipelineHops && parsed.pipelineHops.length >= 2) {
    const first = parsed.pipelineHops[0];
    const last = parsed.pipelineHops[parsed.pipelineHops.length - 1];
    return {
      ...parsed,
      useLoop: false,
      includeLend: parsed.pipelineHops.some((h) => h.kind === "lend"),
      includeSwap: parsed.pipelineHops.some((h) => h.kind === "swap"),
      lendAction: first.kind === "lend" ? first.action ?? "enter" : parsed.lendAction,
      coin: parsed.coin || first.assetIn,
      toCoin: parsed.toCoin || last.assetOut,
      depositChain: parsed.depositChain || "Solana Devnet",
    };
  }
  const inferred = inferPipelineHopsFromPrompt(prompt, parsed.amount);
  if (!inferred) return parsed;
  const first = inferred[0];
  const last = inferred[inferred.length - 1];
  const wantsOut =
    /\bbridge\b/i.test(prompt) ||
    /\bsepolia\b/i.test(prompt) ||
    /\bwithdraw\b/i.test(prompt) ||
    /\bethereum\b/i.test(prompt);
  return {
    ...parsed,
    pipelineHops: inferred,
    useLoop: false,
    includeLend: inferred.some((h) => h.kind === "lend"),
    includeSwap: inferred.some((h) => h.kind === "swap"),
    lendAction: first.kind === "lend" ? first.action ?? "enter" : parsed.lendAction,
    coin: parsed.coin || first.assetIn || "USDC",
    toCoin: parsed.toCoin || last.assetOut,
    amount: parsed.amount,
    depositChain: /solana/i.test(parsed.depositChain) ? parsed.depositChain : "Solana Devnet",
    includeWithdraw: parsed.includeWithdraw || wantsOut,
    withdrawChain: wantsOut
      ? /\bsepolia\b/i.test(prompt)
        ? "ETH Sepolia"
        : parsed.withdrawChain
      : parsed.withdrawChain,
  };
}
