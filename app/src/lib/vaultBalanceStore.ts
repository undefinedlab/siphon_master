"use client";

import { useSyncExternalStore } from "react";
import { TOKEN_MAP } from "./nexus";
import { getSelectedChainId } from "./networks";
import {
  getSpendableVaultBalance,
  getLocalVaultNoteTotals,
  invalidateLeafCache,
} from "./zkHandler";
import { resolvePendingOutputNotes } from "./outputNoteResolver";
import { walletManager } from "@/components/extensions/walletManager";

/** Single shared poll interval for all vault-balance UI surfaces. */
export const VAULT_BALANCE_POLL_MS = 120_000;

export type VaultBalanceSnapshot = {
  chainId: number;
  /** On-chain reconciled per-token amounts. */
  details: Record<string, number>;
  /** Merged with local note totals for display (UserDash / wallet widget). */
  display: Record<string, number>;
  ethBalance: number;
  loading: boolean;
  updatedAt: number | null;
  error: string | null;
};

const EMPTY: VaultBalanceSnapshot = {
  chainId: getSelectedChainId(),
  details: {},
  display: {},
  ethBalance: 0,
  loading: false,
  updatedAt: null,
  error: null,
};

let snapshot: VaultBalanceSnapshot = { ...EMPTY, loading: true };
let subscribers = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function hasWalletSession(): boolean {
  if (typeof window === "undefined") return false;
  const w =
    walletManager.getPrimaryWallet() ??
    walletManager.getConnectedWallets().find((x) => x.id === "evm") ??
    null;
  return Boolean(w?.id === "evm");
}

function buildDisplay(
  chainId: number,
  details: Record<string, number>,
): Record<string, number> {
  const local = getLocalVaultNoteTotals(chainId);
  const display: Record<string, number> = {};
  for (const sym of ["ETH", "USDC"]) {
    const onChain = details[sym] ?? 0;
    const fromNotes = local[sym] ?? 0;
    const amount = onChain > 0 ? onChain : fromNotes;
    if (amount > 0) display[sym] = amount;
  }
  return display;
}

function ethFromDetails(details: Record<string, number>): number {
  const key = Object.keys(details).find((k) => k.toUpperCase() === "ETH");
  return key ? details[key] : 0;
}

async function loadVaultBalance(options?: {
  syncPendingNotes?: boolean;
  chainId?: number;
}) {
  const chainId = options?.chainId ?? getSelectedChainId();

  if (!hasWalletSession()) {
    snapshot = {
      chainId,
      details: {},
      display: {},
      ethBalance: 0,
      loading: false,
      updatedAt: Date.now(),
      error: null,
    };
    emit();
    return;
  }

  if (options?.syncPendingNotes !== false) {
    try {
      await resolvePendingOutputNotes();
      // Pull the server's spent flags into localStorage so getLocalVaultNoteTotals stops counting
      // already-withdrawn notes. Without this, once everything is withdrawn the on-chain-reconciled
      // total is 0, buildDisplay falls back to raw LOCAL note totals, and notes that are spent on the
      // server (but whose local spent flag was never updated during the poll) keep showing as a
      // PHANTOM balance until a manual __siphonResync. syncFromServer marks them spent so the display
      // drops to the real spendable total.
      const { getSigner } = await import("./nexus");
      const signer = getSigner();
      // v2 sync only on a v2 chain. syncFromServer writes into the `siphon-note-` keyspace, which
      // the v3 planner never reads, so running it on a v3 chain produced notes that look real and
      // can never be spent. UserDash already branches on this; these callers did not.
      const { v3Deployed } = await import("./v3/configV3");
      if (signer && !v3Deployed(chainId)) {
        const { syncFromServer } = await import("./localNoteStore");
        await syncFromServer(signer);
      }
    } catch {
      /* best-effort */
    }
  }

  try {
    const { details } = await getSpendableVaultBalance(chainId, TOKEN_MAP);
    const display = buildDisplay(chainId, details);
    snapshot = {
      chainId,
      details,
      display,
      ethBalance: ethFromDetails(details),
      loading: false,
      updatedAt: Date.now(),
      error: null,
    };
  } catch (err) {
    snapshot = {
      ...snapshot,
      chainId,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  emit();
}

function runLoad(options?: Parameters<typeof loadVaultBalance>[0]) {
  if (inflight) return inflight;
  snapshot = { ...snapshot, loading: snapshot.updatedAt === null };
  emit();
  inflight = loadVaultBalance(options).finally(() => {
    inflight = null;
  });
  return inflight;
}

function startPollTimer() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    if (!inflight && hasWalletSession()) void runLoad({ syncPendingNotes: true });
  }, VAULT_BALANCE_POLL_MS);
}

function stopPollTimer() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function onWalletOrChainEvent() {
  void runLoad({ syncPendingNotes: true, chainId: getSelectedChainId() });
}

function installGlobalListeners() {
  if (typeof window === "undefined") return;
  window.addEventListener("siphon:vaultBalanceInvalidate", onWalletOrChainEvent);
  window.addEventListener("walletConnected", onWalletOrChainEvent);
  window.addEventListener("walletDisconnected", onWalletOrChainEvent);
  window.addEventListener("siphon:chainChanged", onWalletOrChainEvent);
  window.addEventListener("siphon:walletChainChanged", onWalletOrChainEvent);
  window.addEventListener("siphon:networkReady", onWalletOrChainEvent);
}

let listenersInstalled = false;

export function getVaultBalanceSnapshot(): VaultBalanceSnapshot {
  return snapshot;
}

export function subscribeVaultBalance(listener: () => void): () => void {
  listeners.add(listener);
  subscribers += 1;

  if (!listenersInstalled) {
    listenersInstalled = true;
    installGlobalListeners();
  }

  if (snapshot.updatedAt === null || snapshot.chainId !== getSelectedChainId()) {
    void runLoad({ syncPendingNotes: true });
  }

  startPollTimer();

  return () => {
    listeners.delete(listener);
    subscribers -= 1;
    if (subscribers === 0) stopPollTimer();
  };
}

/** Manual refresh — bust leaf cache so a just-landed deposit is picked up immediately. */
export async function refreshVaultBalance(options?: {
  syncServerNotes?: boolean;
  invalidateLeaves?: boolean;
}) {
  if (options?.invalidateLeaves !== false) {
    invalidateLeafCache();
  }
  if (options?.syncServerNotes) {
    try {
      const { getSigner, isInitialized } = await import("./nexus");
      const { syncWalletNotesFromServer } = await import("./localNoteStore");
      const { v3Deployed } = await import("./v3/configV3");
      const { getSelectedChainId } = await import("./networks");
      const signer = isInitialized() ? getSigner() : null;
      // See above: the v2 down-sync must not run on a v3 chain. No chainId parameter here, so the
      // selected chain is the right one — it is what the dashboard is showing.
      if (signer && !v3Deployed(getSelectedChainId())) {
        await syncWalletNotesFromServer(signer);
      }
    } catch {
      /* optional */
    }
  }
  await runLoad({ syncPendingNotes: true });
}

export function useVaultBalance(): VaultBalanceSnapshot {
  return useSyncExternalStore(subscribeVaultBalance, getVaultBalanceSnapshot, getVaultBalanceSnapshot);
}
