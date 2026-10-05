/**
 * Persist the active strategy-run note cursor (localStorage).
 *
 * Fail-open: cursor bugs must never block deposit / swap / resolve. Call sites wrap in try/catch
 * and these helpers never throw into the durable note path.
 */

import {
  advanceCursorOnBridge,
  advanceCursorOnDeposit,
  advanceCursorOnSwap,
  advanceCursorOnWithdraw,
  createNoteCursor,
  noteCursorRef,
  type NoteCursor,
  type NoteCursorRef,
} from "./noteCursor";

const STORAGE_KEY = "siphon.noteCursor.v1";

function newRunId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function loadNoteCursor(): NoteCursor | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NoteCursor;
    if (!parsed?.runId || !Array.isArray(parsed.lineage)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveNoteCursor(cursor: NoteCursor): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cursor));
  } catch {
    /* private mode / quota — cursor is UX state, not custody */
  }
}

export function clearNoteCursor(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Start a fresh run on deposit (replaces any prior cursor). */
export function recordDepositOnCursor(params: {
  chainId: number;
  symbol: string;
  commitment: string;
  value: string | bigint;
  txHash?: string;
  noteKey?: string;
}): NoteCursor | null {
  try {
    const next = noteCursorRef(params);
    const cursor = advanceCursorOnDeposit(createNoteCursor(newRunId()), next, {
      txHash: params.txHash,
    });
    saveNoteCursor(cursor);
    return cursor;
  } catch (e) {
    console.warn("[noteCursor] deposit advance skipped:", e);
    return null;
  }
}

/**
 * Same-chain swap output minted. Advances only when a cursor is active on this chain.
 * Returns null when there is nothing to advance (no run, wrong chain, or empty active).
 */
export function recordSwapOnCursor(params: {
  chainId: number;
  symbol: string;
  commitment: string;
  value: string | bigint;
  txHash?: string;
  noteKey?: string;
}): NoteCursor | null {
  try {
    const cur = loadNoteCursor();
    if (!cur?.active) return null;
    if (cur.active.chainId !== params.chainId) {
      console.warn(
        `[noteCursor] swap resolve on ${params.chainId} ignored — active is ${cur.active.chainId}`,
      );
      return null;
    }
    const next = noteCursorRef(params);
    const advanced = advanceCursorOnSwap(cur, next, { txHash: params.txHash });
    saveNoteCursor(advanced);
    return advanced;
  } catch (e) {
    console.warn("[noteCursor] swap advance skipped:", e);
    return null;
  }
}

/** Vault↔vault bridge — mainnet corridors only (see noteCursor.assertMainnetBridgeCorridor). */
export function recordBridgeOnCursor(params: {
  chainId: number;
  symbol: string;
  commitment: string;
  value: string | bigint;
  txHash?: string;
  noteKey?: string;
}): NoteCursor | null {
  try {
    const cur = loadNoteCursor();
    if (!cur?.active) {
      throw new Error("no active note — deposit before bridge");
    }
    const next = noteCursorRef(params);
    const advanced = advanceCursorOnBridge(cur, next, { txHash: params.txHash });
    saveNoteCursor(advanced);
    return advanced;
  } catch (e) {
    console.warn("[noteCursor] bridge advance skipped:", e);
    return null;
  }
}

export function recordWithdrawOnCursor(opts?: {
  txHash?: string;
  toWalletLabel?: string;
}): NoteCursor | null {
  try {
    const cur = loadNoteCursor();
    if (!cur?.active) return null;
    const advanced = advanceCursorOnWithdraw(cur, opts);
    saveNoteCursor(advanced);
    return advanced;
  } catch (e) {
    console.warn("[noteCursor] withdraw advance skipped:", e);
    return null;
  }
}

export function peekActiveNoteCursor(): NoteCursorRef | null {
  return loadNoteCursor()?.active ?? null;
}
