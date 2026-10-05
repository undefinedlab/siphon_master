/**
 * Vault↔vault bridge leg — Base ↔ Arbitrum, ETH/USDC (v1 channel).
 *
 * Li.Fi moves funds between Siphon vaults (not user EOAs). Builder Bridge node + Run auto-execute
 * call {@link prepareVaultBridgeLeg} then the client execute path (withdraw → Li.Fi → deposit).
 */

import {
  ARBITRUM_VAULT_CHAIN_ID,
  BASE_VAULT_CHAIN_ID,
} from "@/lib/chains/productGates";
import {
  assertBridgeChannelAsset,
  assertMainnetBridgeCorridor,
  BRIDGE_CHANNEL_ASSETS,
  isMainnetBridgeCorridor,
} from "./noteCursor";
import {
  peekActiveNoteCursor,
  recordBridgeOnCursor,
} from "./noteCursorSession";
import type { NoteCursor } from "./noteCursor";

export type BridgeVaultOption = {
  label: string;
  chainId: number;
};

/** Destinations the Bridge builder block may target (v1: Base ↔ Arbitrum). */
export const BRIDGE_VAULT_OPTIONS: readonly BridgeVaultOption[] = [
  { label: "Arbitrum", chainId: ARBITRUM_VAULT_CHAIN_ID },
  { label: "Base", chainId: BASE_VAULT_CHAIN_ID },
] as const;

export const BRIDGE_ASSET_OPTIONS = ["USDC", "ETH"] as const;

const LABEL_ALIASES: Record<string, number> = {
  arbitrum: ARBITRUM_VAULT_CHAIN_ID,
  "arbitrum one": ARBITRUM_VAULT_CHAIN_ID,
  arb: ARBITRUM_VAULT_CHAIN_ID,
  base: BASE_VAULT_CHAIN_ID,
  "base mainnet": BASE_VAULT_CHAIN_ID,
};

export function bridgeVaultLabel(chainId: number): string | null {
  return BRIDGE_VAULT_OPTIONS.find((o) => o.chainId === chainId)?.label ?? null;
}

export function resolveBridgeVaultChainId(labelOrId: string | number | null | undefined): number | null {
  if (labelOrId == null || labelOrId === "") return null;
  if (typeof labelOrId === "number") {
    return Number.isFinite(labelOrId) && labelOrId > 0 ? labelOrId : null;
  }
  const trimmed = labelOrId.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return LABEL_ALIASES[trimmed.toLowerCase()] ?? null;
}

export type VaultBridgePrepareResult =
  | {
      ok: true;
      fromChainId: number;
      toChainId: number;
      fromLabel: string;
      toLabel: string;
      activeNoteKey: string;
      symbol: string;
      message: string;
    }
  | { ok: false; error: string };

export type VaultBridgeValidateResult =
  | {
      ok: true;
      fromChainId: number;
      toChainId: number;
      fromLabel: string;
      toLabel: string;
      symbol: string;
    }
  | { ok: false; error: string };

/** Corridor + asset only (no cursor) — safe for builder Run preflight before deposit. */
export function validateVaultBridgeBlock(params: {
  fromChain: string | number | null | undefined;
  toChain: string | number | null | undefined;
  symbol?: string | null;
}): VaultBridgeValidateResult {
  const fromChainId = resolveBridgeVaultChainId(params.fromChain);
  const toChainId = resolveBridgeVaultChainId(params.toChain);
  if (fromChainId == null) {
    return { ok: false, error: "Bridge needs a source vault (Arbitrum or Base)." };
  }
  if (toChainId == null) {
    return { ok: false, error: "Bridge needs a destination vault (Arbitrum or Base)." };
  }
  if (fromChainId === toChainId) {
    return { ok: false, error: "Bridge source and destination must be different vaults." };
  }
  if (!isMainnetBridgeCorridor(fromChainId, toChainId)) {
    try {
      assertMainnetBridgeCorridor(fromChainId, toChainId);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Bridge corridor not allowed.",
      };
    }
  }
  const symbol = (params.symbol || "USDC").trim().toUpperCase();
  try {
    assertBridgeChannelAsset(symbol);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unsupported bridge asset." };
  }
  return {
    ok: true,
    fromChainId,
    toChainId,
    fromLabel: bridgeVaultLabel(fromChainId) ?? String(fromChainId),
    toLabel: bridgeVaultLabel(toChainId) ?? String(toChainId),
    symbol,
  };
}

/** Validate a builder Bridge node before run (corridor + active cursor on source). */
export function prepareVaultBridgeLeg(params: {
  fromChain: string | number | null | undefined;
  toChain: string | number | null | undefined;
  symbol?: string | null;
}): VaultBridgePrepareResult {
  const base = validateVaultBridgeBlock(params);
  if (!base.ok) return base;

  const active = peekActiveNoteCursor();
  if (!active) {
    return {
      ok: false,
      error: "No active note — deposit into the source vault before bridging.",
    };
  }
  if (active.chainId !== base.fromChainId) {
    const have = bridgeVaultLabel(active.chainId) ?? String(active.chainId);
    return {
      ok: false,
      error: `Active note is on ${have}, but this bridge starts from ${base.fromLabel}.`,
    };
  }
  const symbol = (params.symbol || active.symbol || base.symbol).toUpperCase();
  if (active.symbol.toUpperCase() !== symbol) {
    return {
      ok: false,
      error: `Active note is ${active.symbol}, but bridge asks for ${symbol}.`,
    };
  }
  if (!BRIDGE_CHANNEL_ASSETS.has(symbol)) {
    return { ok: false, error: `Vault bridge supports USDC and ETH only (got ${symbol}).` };
  }

  return {
    ok: true,
    fromChainId: base.fromChainId,
    toChainId: base.toChainId,
    fromLabel: base.fromLabel,
    toLabel: base.toLabel,
    activeNoteKey: active.noteKey,
    symbol,
    message: `Ready to bridge vault note ${symbol} ${base.fromLabel} → ${base.toLabel} (Li.Fi).`,
  };
}

/**
 * After Li.Fi lands and the destination vault deposit mints a note, advance the run cursor.
 */
export function finalizeVaultBridgeOnCursor(params: {
  toChainId: number;
  symbol: string;
  commitment: string;
  value: string | bigint;
  txHash?: string;
  noteKey?: string;
}): NoteCursor | null {
  return recordBridgeOnCursor({
    chainId: params.toChainId,
    symbol: params.symbol,
    commitment: params.commitment,
    value: params.value,
    txHash: params.txHash,
    noteKey: params.noteKey,
  });
}

/** Parse "from Arbitrum to Base" / "bridge to Solana" / "on Arbitrum, bridge to Base". */
export function detectBridgeChainsFromPrompt(prompt: string): {
  from: string | null;
  to: string | null;
} {
  const chain = "(arbitrum(?:\\s+one)?|arb|base)";
  const fromTo = prompt.match(
    new RegExp(
      `\\b(?:bridge|move|transfer)\\b[\\s\\S]{0,48}?\\bfrom\\s+${chain}\\b[\\s\\S]{0,24}?\\bto\\s+${chain}\\b`,
      "i",
    ),
  );
  if (fromTo) {
    return {
      from: canonicalizeBridgeLabel(fromTo[1]),
      to: canonicalizeBridgeLabel(fromTo[2]),
    };
  }
  const onThenBridge = prompt.match(
    new RegExp(`\\bon\\s+${chain}\\b[\\s\\S]{0,48}?\\b(?:bridge|move|transfer)\\b[\\s\\S]{0,24}?\\bto\\s+${chain}\\b`, "i"),
  );
  if (onThenBridge) {
    return {
      from: canonicalizeBridgeLabel(onThenBridge[1]),
      to: canonicalizeBridgeLabel(onThenBridge[2]),
    };
  }
  const toOnly = prompt.match(
    new RegExp(`\\b(?:bridge|move|transfer)\\b[\\s\\S]{0,40}?\\bto\\s+${chain}\\b`, "i"),
  );
  if (toOnly) {
    return { from: null, to: canonicalizeBridgeLabel(toOnly[1]) };
  }
  return { from: null, to: null };
}

function canonicalizeBridgeLabel(raw: string): string {
  const id = resolveBridgeVaultChainId(raw);
  return id != null ? (bridgeVaultLabel(id) ?? raw) : raw;
}
