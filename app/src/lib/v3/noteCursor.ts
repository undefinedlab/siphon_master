/**
 * Note cursor — one active note per strategy run.
 *
 * Deposit / swap / bridge legs consume the active note and point the cursor at the next one.
 * Notes stay chain-local; a bridge always spends on the source vault and mints on the dest vault.
 *
 * Real vault↔vault Li.Fi hops are mainnet-only. v1 executable corridor = Base ↔ Arbitrum
 * (ETH/USDC). Devnet may use the cursor for same-chain legs; Solana Devnet / Sepolia refuse.
 */

import {
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
} from "@/lib/chains/registry";
import { ARBITRUM_VAULT_CHAIN_ID, BASE_VAULT_CHAIN_ID } from "@/lib/chains/productGates";
import { v3NoteKey } from "./noteStoreV3";

export type NoteCursorLegKind = "deposit" | "swap" | "bridge" | "withdraw";

/** Pointer at a single spendable note on one vault chain. */
export type NoteCursorRef = {
  chainId: number;
  /** Opaque store key (v3 or Solana). Prefer {@link cursorNoteKey}. */
  noteKey: string;
  symbol: string;
  /** Note value as decimal string (base units), matching StoredV3Note.value. */
  value: string;
  commitment: string;
};

export type NoteCursorLineageEntry = {
  kind: NoteCursorLegKind;
  at: number;
  /** Note spent by this leg (absent on the opening deposit). */
  from?: NoteCursorRef;
  /** Note (or withdraw endpoint) the cursor moves to. */
  to: NoteCursorRef;
  txHash?: string;
  /** Set on bridge legs — destination vault chain id. */
  bridgeToChainId?: number;
};

export type NoteCursor = {
  runId: string;
  active: NoteCursorRef | null;
  lineage: NoteCursorLineageEntry[];
};

/**
 * v1 executable vault↔vault Li.Fi corridor: Base ↔ Arbitrum only.
 * (Solana mainnet stays a fund door / future corridor — not auto-executed yet.)
 */
export const MAINNET_BRIDGE_VAULT_CHAIN_IDS: ReadonlySet<number> = new Set([
  BASE_VAULT_CHAIN_ID,
  ARBITRUM_VAULT_CHAIN_ID,
]);

/** Assets allowed on the Base↔Arb bridge channel. */
export const BRIDGE_CHANNEL_ASSETS: ReadonlySet<string> = new Set(["USDC", "ETH"]);

export function isSolanaVaultChainId(chainId: number): boolean {
  return chainId === SOLANA_MAINNET_CHAIN_ID || chainId === SOLANA_DEVNET_CHAIN_ID;
}

/** Stable note key for the cursor (EVM uses v3 keys; Solana uses a parallel prefix). */
export function cursorNoteKey(chainId: number, symbol: string, commitment: string): string {
  const sym = symbol.toUpperCase();
  const c = commitment.trim();
  if (!c) throw new Error("cursorNoteKey: commitment required");
  if (isSolanaVaultChainId(chainId)) {
    return `siphon-solnote-${chainId}-${sym}-${c}`;
  }
  return v3NoteKey(chainId, sym, c);
}

export function createNoteCursor(runId: string): NoteCursor {
  const id = runId.trim();
  if (!id) throw new Error("createNoteCursor: runId required");
  return { runId: id, active: null, lineage: [] };
}

export function noteCursorRef(params: {
  chainId: number;
  symbol: string;
  commitment: string;
  value: string | bigint;
  noteKey?: string;
}): NoteCursorRef {
  const symbol = params.symbol.toUpperCase();
  const commitment = params.commitment.trim();
  if (!Number.isFinite(params.chainId) || params.chainId <= 0) {
    throw new Error(`noteCursorRef: invalid chainId ${params.chainId}`);
  }
  if (!symbol) throw new Error("noteCursorRef: symbol required");
  if (!commitment) throw new Error("noteCursorRef: commitment required");
  const value = typeof params.value === "bigint" ? params.value.toString() : String(params.value).trim();
  if (!value || !/^\d+$/.test(value)) {
    throw new Error("noteCursorRef: value must be a non-negative integer string (base units)");
  }
  return {
    chainId: params.chainId,
    noteKey: params.noteKey ?? cursorNoteKey(params.chainId, symbol, commitment),
    symbol,
    value,
    commitment,
  };
}

/**
 * Opening leg: deposit mints the first note and becomes the active cursor.
 */
export function advanceCursorOnDeposit(
  cursor: NoteCursor,
  next: NoteCursorRef,
  opts?: { txHash?: string; at?: number },
): NoteCursor {
  if (cursor.active) {
    throw new Error("advanceCursorOnDeposit: run already has an active note — use swap/bridge advance");
  }
  const entry: NoteCursorLineageEntry = {
    kind: "deposit",
    at: opts?.at ?? Date.now(),
    to: next,
    txHash: opts?.txHash,
  };
  return {
    ...cursor,
    active: next,
    lineage: [...cursor.lineage, entry],
  };
}

/**
 * Same-chain spend: swap (or withdraw-shaped same-vault mint). Consumes active, points at `next`.
 */
export function advanceCursorOnSwap(
  cursor: NoteCursor,
  next: NoteCursorRef,
  opts?: { txHash?: string; at?: number },
): NoteCursor {
  const from = requireActive(cursor, "advanceCursorOnSwap");
  if (from.chainId !== next.chainId) {
    throw new Error(
      `advanceCursorOnSwap: same-chain only (active ${from.chainId} → next ${next.chainId}); use bridge`,
    );
  }
  return appendSpend(cursor, from, next, "swap", opts);
}

/**
 * Cross-vault hop: spend on source chain, mint on destination. Li.Fi corridors are mainnet-only.
 */
export function advanceCursorOnBridge(
  cursor: NoteCursor,
  next: NoteCursorRef,
  opts?: { txHash?: string; at?: number },
): NoteCursor {
  const from = requireActive(cursor, "advanceCursorOnBridge");
  if (from.chainId === next.chainId) {
    throw new Error("advanceCursorOnBridge: source and destination must differ");
  }
  assertMainnetBridgeCorridor(from.chainId, next.chainId);
  return appendSpend(cursor, from, next, "bridge", {
    ...opts,
    bridgeToChainId: next.chainId,
  });
}

/**
 * Terminal leg: funds leave Siphon vaults. Cursor becomes null; lineage keeps the spent note.
 */
export function advanceCursorOnWithdraw(
  cursor: NoteCursor,
  opts?: { txHash?: string; at?: number; toWalletLabel?: string },
): NoteCursor {
  const from = requireActive(cursor, "advanceCursorOnWithdraw");
  const to: NoteCursorRef = {
    ...from,
    noteKey: opts?.toWalletLabel?.trim()
      ? `withdraw:${opts.toWalletLabel.trim()}`
      : `withdraw:${from.noteKey}`,
    commitment: `withdraw:${from.commitment}`,
    value: "0",
  };
  const entry: NoteCursorLineageEntry = {
    kind: "withdraw",
    at: opts?.at ?? Date.now(),
    from,
    to,
    txHash: opts?.txHash,
  };
  return {
    ...cursor,
    active: null,
    lineage: [...cursor.lineage, entry],
  };
}

/** True when both ends are distinct mainnet vault chains we allow Li.Fi between. */
export function isMainnetBridgeCorridor(fromChainId: number, toChainId: number): boolean {
  if (fromChainId === toChainId) return false;
  return (
    MAINNET_BRIDGE_VAULT_CHAIN_IDS.has(fromChainId) &&
    MAINNET_BRIDGE_VAULT_CHAIN_IDS.has(toChainId)
  );
}

export function assertMainnetBridgeCorridor(fromChainId: number, toChainId: number): void {
  if (fromChainId === SOLANA_DEVNET_CHAIN_ID || toChainId === SOLANA_DEVNET_CHAIN_ID) {
    throw new Error(
      "Vault bridge is mainnet-only — Solana Devnet has no Li.Fi corridor to Arb/Base",
    );
  }
  if (!isMainnetBridgeCorridor(fromChainId, toChainId)) {
    throw new Error(
      `Vault bridge corridor not allowed: ${fromChainId} → ${toChainId} ` +
        `(v1 channel: Base ${BASE_VAULT_CHAIN_ID} ↔ Arbitrum ${ARBITRUM_VAULT_CHAIN_ID}, ETH/USDC)`,
    );
  }
}

export function assertBridgeChannelAsset(symbol: string): void {
  const sym = symbol.trim().toUpperCase();
  if (!BRIDGE_CHANNEL_ASSETS.has(sym)) {
    throw new Error(`Vault bridge supports USDC and ETH only (got ${symbol || "empty"})`);
  }
}

export function activeChainId(cursor: NoteCursor): number | null {
  return cursor.active?.chainId ?? null;
}

export function lineageSummary(cursor: NoteCursor): string {
  if (cursor.lineage.length === 0) return `(${cursor.runId}) empty`;
  const parts = cursor.lineage.map((e) => {
    if (e.kind === "deposit") return `deposit@${e.to.chainId}`;
    if (e.kind === "bridge") return `bridge ${e.from?.chainId}→${e.bridgeToChainId ?? e.to.chainId}`;
    if (e.kind === "withdraw") return `withdraw@${e.from?.chainId}`;
    return `swap@${e.to.chainId}`;
  });
  const tip = cursor.active
    ? `active ${cursor.active.symbol}@${cursor.active.chainId}`
    : "active none";
  return `(${cursor.runId}) ${parts.join(" → ")} · ${tip}`;
}

function requireActive(cursor: NoteCursor, op: string): NoteCursorRef {
  if (!cursor.active) throw new Error(`${op}: no active note — deposit first`);
  return cursor.active;
}

function appendSpend(
  cursor: NoteCursor,
  from: NoteCursorRef,
  next: NoteCursorRef,
  kind: "swap" | "bridge",
  opts?: { txHash?: string; at?: number; bridgeToChainId?: number },
): NoteCursor {
  const entry: NoteCursorLineageEntry = {
    kind,
    at: opts?.at ?? Date.now(),
    from,
    to: next,
    txHash: opts?.txHash,
    bridgeToChainId: opts?.bridgeToChainId,
  };
  return {
    ...cursor,
    active: next,
    lineage: [...cursor.lineage, entry],
  };
}
