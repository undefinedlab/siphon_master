"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  abortStrategy,
  formatStrategyStatus,
  getExplorerTxUrl,
  getStrategies,
  isActiveStatus,
  isExecutorUnreachableError,
  type StrategyRecord,
} from "@/lib/strategyApi";
import { getSigner } from "@/lib/nexus";
import { getNetwork, SOLANA_DEVNET_UI_CHAIN_ID } from "@/lib/networks";
import { showAppConfirm, showAppToast } from "@/lib/appToast";
import { ragequit, recoverAllRejected, flaggedRagequitBalance, type DepositScreening } from "@/lib/handler";
import { RAGEQUIT_GRACE_SECONDS } from "@/lib/v3/ragequitGraceV3";
import { busEtaText, countdown } from "@/lib/v3/aspBusV3";
import { invalidateScreening, refreshScreening } from "@/lib/v3/screeningStore";
import { invalidateLeafCache } from "@/lib/zkHandler";
import {
  exportUserActivitiesCsv,
  getUserActivities,
  type UserActivityEntry,
  type UserActivityKind,
} from "@/lib/userActivityLog";
import ReceiptModal, { type ReceiptPrefill } from "./ReceiptModal";

interface ActivityLogProps {
  walletAddress: string;
  /** Active chain — deposits/withdrawals are scoped to it. Entries without a chainId (strategies,
   * which carry none, plus legacy rows) show on every chain since they can't be scoped. */
  chainId?: number;
}

type ActivityFilter = "all" | "deposits" | "withdrawals" | "strategies" | "live";

interface ActivityRow {
  id: string;
  kind: UserActivityKind;
  title: string;
  subtitle: string;
  status: string;
  statusClass: string;
  timestamp: string;
  txHash: string | null;
  relatedTxHash?: string | null;
  isActive: boolean;
  amount?: string;
  token?: string;
  chainId?: number;
  noteKey?: string;
  isOriginal?: boolean;
  /** Checking rows: false once the five-minute public-exit window has closed (server refuses). */
  ragequitOpen?: boolean;
}

function strategyToRow(s: StrategyRecord): ActivityRow {
  const active = isActiveStatus(s.status);
  return {
    id: `strategy-${s.id}`,
    kind: "strategy",
    title: `${s.amount} ${s.asset_in} → ${s.asset_out}`,
    subtitle: s.strategy_type.replace(/_/g, " "),
    status: formatStrategyStatus(s.status),
    statusClass: s.status.toLowerCase(),
    timestamp: s.executed_at ?? s.result_updated_at ?? s.created_at,
    txHash: s.tx_hash,
    isActive: active,
    chainId: s.from_chain ? Number(s.from_chain) : undefined,
  };
}

// Short chain badge for a log row — "Base" / "Sepolia" / "Base Sepolia".
function chainBadge(chainId?: number): string | null {
  if (chainId == null) return null;
  return getNetwork(chainId).name.replace("Ethereum ", "");
}

function localToRow(e: UserActivityEntry): ActivityRow {
  const status = e.status ?? "logged";
  return {
    id: e.id,
    kind: e.kind,
    title: e.label ?? `${e.kind} ${e.amount ?? ""} ${e.token ?? ""}`.trim(),
    subtitle:
      e.status === "ragequit"
        ? "Public exit to original depositor"
        : e.kind === "deposit"
        ? "Vault deposit"
        : e.kind === "withdraw"
          ? "Vault withdraw"
          : "Strategy launch",
    status,
    statusClass:
      status === "ragequit"
        ? "ragequit"
        : status === "in checking" || status === "checking"
        ? "checking"
        : status === "confirmed" || status === "EXECUTED" || status === "executed"
        ? "executed"
        : status === "FAILED" || status === "failed" || status === "flagged"
          ? status === "flagged" ? "flagged" : "failed"
          : activeStatus(status)
            ? "armed"
            : "pending",
    timestamp: e.timestamp,
    txHash: e.txHash ?? null,
    relatedTxHash: e.relatedTxHash ?? null,
    isActive: status === "in checking" || status === "checking" || activeStatus(status),
    amount: e.amount != null ? String(e.amount) : undefined,
    token: e.token,
    chainId: e.chainId,
    noteKey: e.noteKey,
  };
}

function screeningFor(row: ActivityRow, list: DepositScreening[]): DepositScreening | undefined {
  if (row.kind !== "deposit") return undefined;
  if (row.noteKey) return list.find((s) => s.noteKey === row.noteKey);
  const amt = String(row.amount ?? "");
  const hits = list.filter(
    (s) => s.token === row.token && String(s.amount) === amt,
  );
  return hits.length === 1 ? hits[0] : undefined;
}

function checkingCopy(
  isOriginal: boolean,
  graceDeadlineMs: number | undefined,
  busEtaMs: number | undefined,
  nowMs: number,
): string {
  const bus = busEtaText(busEtaMs, nowMs);
  if (!isOriginal) return `Change note — not spendable yet, ${bus}`;
  const exit = graceDeadlineMs && graceDeadlineMs > nowMs ? ` · public ragequit open ${countdown(graceDeadlineMs, nowMs)} more` : "";
  return `Not spendable yet — ${bus}${exit}`;
}

/** A deposit row settled as done — the deposit landed and nothing is pending on it. */
function settledDeposit(row: ActivityRow): ActivityRow {
  return { ...row, status: "confirmed", statusClass: "executed", isActive: false, subtitle: "Vault deposit" };
}

export function applyScreening(
  row: ActivityRow,
  screen: DepositScreening | undefined,
  nowMs: number = Date.now(),
): ActivityRow {
  if (row.status === "ragequit" || row.statusClass === "ragequit") return row;
  if (!screen) {
    // Deposits are saved as "in checking" at submit and that entry is never rewritten. Past the
    // five-minute window the screening list returns no row for any non-revoked note, so it can
    // never confirm "checking" again — holding the stored status showed a clock and a ragequit
    // button forever on an admitted deposit. Revoked notes still come back as flagged rows.
    const ts = row.timestamp ? new Date(row.timestamp).getTime() : NaN;
    const pastWindow = Number.isFinite(ts) && nowMs - ts > RAGEQUIT_GRACE_SECONDS * 1_000;
    return row.kind === "deposit" && row.statusClass === "checking" && pastWindow ? settledDeposit(row) : row;
  }
  if (screen.phase === "flagged") {
    return {
      ...row,
      status: "flagged",
      statusClass: "flagged",
      isActive: false,
      noteKey: screen.noteKey,
      isOriginal: screen.isOriginal,
      subtitle: screen.isOriginal ? "Screening failed" : "Change note — screening failed",
    };
  }
  // `admitted` and `phase` are NOT the same question — see DepositScreening.admitted. A note the
  // ASP has admitted still carries phase 'checking' while its five-minute ragequit window is open;
  // it is not waiting on anything. Reading `phase` alone reported admitted deposits as "in
  // checking", and checkingCopy then told the user "ASP still hasn't admitted this label" about a
  // label admitted minutes earlier — five at once, on a wallet whose every label was admitted.
  // The balance card already reads `admitted` here; this path was the one left conflating them.
  if (screen.admitted) {
    // Admitted means spendable now. During its five-minute window the balance card still offers
    // the public exit; the log just reports the deposit as done instead of a clock.
    return { ...settledDeposit(row), noteKey: screen.noteKey, isOriginal: screen.isOriginal };
  }
  return {
    ...row,
    status: "in checking",
    statusClass: "checking",
    isActive: true,
    noteKey: screen.noteKey,
    isOriginal: screen.isOriginal,
    subtitle: checkingCopy(screen.isOriginal, screen.graceDeadlineMs, screen.busEtaMs, nowMs),
    // Unknown timing (old notes) keeps the button; the server enforces the window at click time.
    ragequitOpen: screen.graceDeadlineMs === undefined ? undefined : screen.graceDeadlineMs > nowMs,
  };
}

function activeStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "pending" || s === "armed" || s === "submitted";
}

function isAdmitted(row: ActivityRow): boolean {
  return row.statusClass !== "checking"
    && row.statusClass !== "flagged"
    && row.statusClass !== "pending"
    && row.statusClass !== "armed"
    && row.statusClass !== "ragequit";
}

/**
 * Which deposits may be offered a ragequit button.
 *
 * FLAGGED goes straight to the existing revoked branch. CHECKING first obtains the ASP's
 * deposit-bound exit ticket, which immediately inserts that pending label into the revoked SMT;
 * it then uses the same already-deployed branch. Admitted deposits are intentionally excluded.
 *
 * Named and tested because this rule was wrong in two places at once: the balance card offered the
 * same impossible button, and fixing only that one left this path still failing in the UI.
 */
export function canRagequitRow(row: {
  kind?: string;
  noteKey?: string | null;
  isOriginal?: boolean;
  statusClass?: string;
  ragequitOpen?: boolean;
}): boolean {
  return row.kind === "deposit" &&
    !!row.noteKey &&
    row.isOriginal !== false &&
    (row.statusClass === "flagged" || (row.statusClass === "checking" && row.ragequitOpen !== false));
}

function showReceipt(row: ActivityRow): boolean {
  if (row.statusClass === "ragequit") return false;
  return row.kind === "deposit" || row.kind === "withdraw";
}

function isSolanaSignature(hash: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(hash);
}

function shortTxHash(hash: string, chainId?: number): string {
  if (chainId === SOLANA_DEVNET_UI_CHAIN_ID || isSolanaSignature(hash)) {
    if (hash.length <= 12) return hash;
    return `${hash.slice(0, 4)}…${hash.slice(-4)}`;
  }
  const h = hash.startsWith("0x") || hash.startsWith("0X") ? hash : `0x${hash}`;
  if (h.length <= 12) return h;
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

function TxChip({
  hash,
  chainId,
  title,
  variant,
}: {
  hash: string;
  chainId?: number;
  title: string;
  variant?: "ragequit";
}) {
  return (
    <a
      href={getExplorerTxUrl(hash, chainId)}
      target="_blank"
      rel="noopener noreferrer"
      className={`userdash-activity-chain userdash-activity-tx${variant === "ragequit" ? " userdash-activity-tx--ragequit" : ""}`}
      title={title}
      onClick={(e) => e.stopPropagation()}
    >
      {shortTxHash(hash, chainId)}
    </a>
  );
}

function IconClockAlert() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="13" r="8" />
      <polyline points="10 9 10 13 13 15" />
      <path d="M18 4v6" />
      <circle cx="18" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function IconDoorExit() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5" />
      <path d="M10 3v18" />
      <path d="M15 8l5 4-5 4" />
      <path d="M20 12H10" />
    </svg>
  );
}

function statusBadge(row: ActivityRow) {
  if (row.statusClass === "checking") {
    return (
      <span className="userdash-activity-badge userdash-activity-badge--icon status-checking" title="In checking" aria-label="In checking">
        <IconClockAlert />
      </span>
    );
  }
  if (row.statusClass === "executed") {
    return (
      <span className="userdash-activity-badge userdash-activity-badge--icon status-executed" title="Admitted" aria-label="Admitted">
        <IconCheck />
      </span>
    );
  }
  if (row.statusClass === "ragequit") {
    return (
      <span className="userdash-activity-badge userdash-activity-badge--icon status-ragequit" title="Ragequit" aria-label="Ragequit">
        <IconDoorExit />
      </span>
    );
  }
  return (
    <span className={`userdash-activity-badge status-${row.statusClass}`}>
      {row.isActive && <span className="userdash-activity-dot" />}
      {row.status}
    </span>
  );
}

export default function ActivityLog({ walletAddress, chainId }: ActivityLogProps) {
  const [localEntries, setLocalEntries] = useState<UserActivityEntry[]>([]);
  const [strategies, setStrategies] = useState<StrategyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [receiptFor, setReceiptFor] = useState<ReceiptPrefill | null>(null);
  const [abortingId, setAbortingId] = useState<string | null>(null);
  const [screening, setScreening] = useState<DepositScreening[]>([]);
  // 1s clock, only while something is waiting for the ASP bus or inside its public-exit window —
  // the countdowns in those rows' subtitles are computed from it.
  const [now, setNow] = useState(() => Date.now());
  const ticking = screening.some((s) => s.phase === "checking");
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [ticking]);
  const [rqBalance, setRqBalance] = useState<Record<string, number>>({});
  const [ragequitAllBusy, setRagequitAllBusy] = useState(false);
  const [showRqHelp, setShowRqHelp] = useState(false);
  const [ragequitBusyKey, setRagequitBusyKey] = useState<string | null>(null);
  const [recoverAllBusy, setRecoverAllBusy] = useState(false);
  // ragequitAllBusy belongs here too: without it, "Ragequit all" left every other exit control
  // enabled, so all three could run at once.
  const ragequitLocked = !!ragequitBusyKey || recoverAllBusy || ragequitAllBusy;

  // Abort an unfired (PENDING/ARMED) strategy straight from the activity log — same executor call the
  // Run view uses. The executor refuses anything already on-chain, so this is safe even if the status
  // is momentarily stale; on-chain funds stay spent, unfired legs are freed (client re-sync restores).
  const handleAbort = useCallback(async (strategyId: string, chainId?: number) => {
    const signer = getSigner();
    if (!signer) { showAppToast("Connect your wallet to abort", "error"); return; }
    setAbortingId(strategyId);
    try {
      const res = await abortStrategy(signer, strategyId, chainId);
      if (res.success) {
        const asset = res.assetIn ?? "";
        const fmt = (n?: number) => (typeof n === "number" ? `${+n.toFixed(6)} ${asset}`.trim() : "");
        showAppToast(
          res.strategyStatus === "PARTIALLY_EXECUTED"
            ? `Strategy stopped — ${fmt(res.spentAmount)} already executed, ${fmt(res.returnedAmount)} restored`
            : `Strategy aborted — ${fmt(res.returnedAmount)} restored to your balance`,
          "success",
        );
        setStrategies((prev) =>
          prev.map((s) => (s.id === strategyId ? { ...s, status: (res.strategyStatus as StrategyRecord["status"]) ?? "ABORTED" } : s)),
        );
      } else if (res.processing) {
        // Started executing on-chain before the abort landed — can't be cancelled now.
        showAppToast(
          "This strategy is already executing on-chain and can no longer be cancelled.",
          "info",
        );
        // Reflect its live status on the card (EXECUTING/EXECUTED) so the abort button drops.
        if (res.strategyStatus) {
          setStrategies((prev) =>
            prev.map((s) => (s.id === strategyId ? { ...s, status: res.strategyStatus as StrategyRecord["status"] } : s)),
          );
        }
      } else {
        showAppToast(res.error || "Failed to abort strategy", "error");
      }
    } finally {
      setAbortingId(null);
    }
  }, []);

  const loadLocal = useCallback(() => {
    setLocalEntries(getUserActivities(walletAddress));
  }, [walletAddress]);

  const loadScreening = useCallback(async () => {
    // Through the shared store: this used to fetch independently every 8s while the dashboard did
    // the same, and listDepositScreening costs one /api/asp-set/member per note against a 30/min
    // cap. The resulting 429s came back as `null` per note, which reads as "no rows" — so the
    // screening list emptied itself and took the ragequit controls with it.
    try {
      setScreening(await refreshScreening());
    } catch {
      // Keep what is on screen; an empty list here is indistinguishable from "all admitted".
    }
    // Connected wallet's flagged (revoked) ragequit balance — what "Ragequit all" recovers.
    try {
      setRqBalance(await flaggedRagequitBalance());
    } catch {
      setRqBalance({});
    }
  }, [chainId]);

  const handleRagequit = useCallback(async (row: ActivityRow) => {
    if (!row.noteKey || !row.token || ragequitLocked) return;
    const amount = `${row.amount ?? ""} ${row.token}`.trim();
    const flagged = row.statusClass === "flagged";
    const ok = await showAppConfirm({
      title: "Ragequit this deposit?",
      message: flagged
        ? `Screening failed. This returns ${amount} to the original depositing wallet — public on-chain. Other deposits stay private.`
        : `Still in checking. This returns ${amount} to the original depositing wallet — public on-chain. Other deposits stay private.`,
      confirmLabel: "Ragequit",
      cancelLabel: "Cancel",
      tone: "danger",
    });
    if (!ok) return;
    setRagequitBusyKey(row.noteKey);
    try {
      const result = await ragequit(row.token, row.noteKey);
      if (result.success) {
        showAppToast(`Ragequit sent ${row.amount ?? ""} ${row.token} back to the original depositor`, "success");
        invalidateLeafCache();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("siphon:vaultBalanceInvalidate"));
          window.dispatchEvent(new Event("siphon:userActivityUpdated"));
        }
        invalidateScreening();
      await loadScreening();
        loadLocal();
      } else {
        showAppToast(`Ragequit failed: ${result.error}`, "error");
      }
    } catch (error: unknown) {
      showAppToast(`Ragequit failed: ${error instanceof Error ? error.message : "Unknown error"}`, "error");
    } finally {
      setRagequitBusyKey(null);
    }
  }, [ragequitLocked, loadScreening, loadLocal]);

  const handleRecoverAll = useCallback(async () => {
    if (ragequitLocked || screening.length === 0) return;
    const n = screening.length;
    const ok = await showAppConfirm({
      title: "Recover all rejected notes?",
      message: `Returns ${n} in-checking and flagged note${n === 1 ? "" : "s"} (including change notes) to the original depositing wallet. Large recoveries may take several public transactions. Notes the chain skips stay in the list.`,
      confirmLabel: "Recover all",
      cancelLabel: "Cancel",
      tone: "danger",
    });
    if (!ok) return;
    setRecoverAllBusy(true);
    try {
      const result = await recoverAllRejected();
      if (result.success && result.recovered > 0) {
        const extra = result.skipped > 0 ? ` (${result.skipped} still pending — retry them)` : "";
        showAppToast(`Recovered ${result.recovered} note${result.recovered === 1 ? "" : "s"}${extra}`, "success");
        invalidateLeafCache();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("siphon:vaultBalanceInvalidate"));
          window.dispatchEvent(new Event("siphon:userActivityUpdated"));
        }
      } else {
        showAppToast(result.error || "Recovery did not spend any notes", "error");
      }
      invalidateScreening();
      await loadScreening();
      loadLocal();
    } catch (error: unknown) {
      showAppToast(`Recover all failed: ${error instanceof Error ? error.message : "Unknown error"}`, "error");
    } finally {
      setRecoverAllBusy(false);
    }
  }, [ragequitLocked, screening.length, loadScreening, loadLocal]);

  // The connected wallet's flagged (revoked) balance — the funds "Ragequit all" recovers.
  const connectedRqTotal = useMemo(
    () => Object.values(rqBalance).reduce((a, b) => a + b, 0),
    [rqBalance],
  );
  // Trim float-sum noise (0.1+0.2 → 0.3) when rendering per-token amounts.
  const fmtByToken = (amountByToken: Record<string, number>) =>
    Object.entries(amountByToken).map(([sym, amt]) => `${+amt.toFixed(6)} ${sym}`).join(" + ");

  // Ragequit ALL flagged funds for the connected wallet, in one batch (all-or-nothing — we never leave
  // revoked/dirty funds shielded). Only flagged notes; checking notes are left to admit normally.
  const handleRagequitAll = useCallback(async () => {
    if (ragequitLocked || ragequitAllBusy || connectedRqTotal <= 0) return;
    const parts = fmtByToken(rqBalance);
    const ok = await showAppConfirm({
      title: "Ragequit all flagged funds?",
      message: `Returns ${parts} to this wallet in one batch — public on-chain. Flagged funds can't be spent privately; ragequit is the only recovery. This recovers ALL of them at once.`,
      confirmLabel: "Ragequit all",
      cancelLabel: "Cancel",
      tone: "danger",
    });
    if (!ok) return;
    setRagequitAllBusy(true);
    try {
      const result = await recoverAllRejected({ flaggedOnly: true });
      if (result.success && result.recovered > 0) {
        const extra = result.skipped > 0 ? ` (${result.skipped} still pending — retry)` : "";
        showAppToast(`Ragequit ${result.recovered} flagged note${result.recovered === 1 ? "" : "s"}${extra}`, "success");
        invalidateLeafCache();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("siphon:vaultBalanceInvalidate"));
          window.dispatchEvent(new Event("siphon:userActivityUpdated"));
        }
      } else {
        showAppToast(result.error || "No flagged notes were recovered", "error");
      }
      invalidateScreening();
      await loadScreening();
      loadLocal();
    } catch (error: unknown) {
      showAppToast(`Ragequit all failed: ${error instanceof Error ? error.message : "Unknown error"}`, "error");
    } finally {
      setRagequitAllBusy(false);
    }
  }, [ragequitLocked, ragequitAllBusy, connectedRqTotal, rqBalance, loadScreening, loadLocal]);

  const fetchRemote = useCallback(async () => {
    if (!walletAddress) return;

    // Solana Devnet orders belong to the Phantom wallet and list with its Phantom session; an EVM
    // address has none there.
    if (chainId === SOLANA_DEVNET_UI_CHAIN_ID && walletAddress.startsWith("0x")) {
      setStrategies([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await getStrategies(walletAddress);
      if (result.success && result.strategies) {
        setStrategies(result.strategies);
      } else if (result.error && !isExecutorUnreachableError(result.error)) {
        setError(result.error);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      // The executor being down is not the activity log. Local deposits still render below;
      // with none of those either, the empty line is "No activity yet".
      if (!isExecutorUnreachableError(message)) setError(message);
    } finally {
      setLoading(false);
    }
  }, [walletAddress, chainId]);

  const refresh = useCallback(async () => {
    loadLocal();
    await Promise.all([fetchRemote(), loadScreening()]);
  }, [loadLocal, fetchRemote, loadScreening]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void fetchRemote();
      // Cheap: the store serves from cache until its own TTL expires, so this stays a UI tick
      // rather than another request per note.
      void loadScreening();
    }, 8_000);
    const onActivity = () => loadLocal();
    const onExecuted = () => void fetchRemote();
    const onFilter = (e: Event) => {
      const detail = (e as CustomEvent<{ filter?: ActivityFilter; strategyId?: string }>).detail;
      if (detail?.filter) setFilter(detail.filter);
    };
    window.addEventListener("siphon:userActivityUpdated", onActivity);
    window.addEventListener("siphon:strategyExecuted", onExecuted);
    window.addEventListener("siphon:activityLogFilter", onFilter);
    return () => {
      clearInterval(interval);
      window.removeEventListener("siphon:userActivityUpdated", onActivity);
      window.removeEventListener("siphon:strategyExecuted", onExecuted);
      window.removeEventListener("siphon:activityLogFilter", onFilter);
    };
  }, [refresh, fetchRemote, loadLocal, loadScreening]);

  const rows = useMemo(() => {
    const strategyIds = new Set(strategies.map((s) => s.id));
    const localNonDupe = localEntries.filter(
      (e) => !(e.kind === "strategy" && e.strategyId && strategyIds.has(e.strategyId)),
    );

    const usedKeys = new Set<string>();
    const merged: ActivityRow[] = [
      ...strategies.map(strategyToRow),
      ...localNonDupe.map(localToRow),
    ].map((row) => {
      const screen = screeningFor(row, screening);
      if (screen) usedKeys.add(screen.noteKey);
      return applyScreening(row, screen, now);
    });

    for (const s of screening) {
      if (usedKeys.has(s.noteKey)) continue;
      // Same rendering rules as rows with an activity entry: flagged / admitted / waiting.
      merged.push(applyScreening({
        id: `screening-${s.noteKey}`,
        kind: "deposit",
        title: `Deposit ${s.amount} ${s.token}`,
        subtitle: "",
        status: "in checking",
        statusClass: "checking",
        timestamp: "",
        txHash: null,
        isActive: true,
        amount: s.amount,
        token: s.token,
        chainId,
      }, s, now));
    }

    merged.sort(
      (a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime(),
    );

    return merged.filter((row) => {
      // Chain scope: hide rows tagged for a different chain. Untagged rows (row.chainId == null —
      // strategies carry none, plus legacy entries) fall through and show on every chain.
      if (chainId != null && row.chainId != null && row.chainId !== chainId) return false;
      if (filter === "all") return true;
      if (filter === "deposits") return row.kind === "deposit";
      if (filter === "withdrawals") return row.kind === "withdraw";
      if (filter === "strategies") return row.kind === "strategy";
      if (filter === "live") return row.isActive;
      return true;
    });
  }, [strategies, localEntries, filter, chainId, screening, now]);

  const showRecoverAll =
    screening.some((s) => s.phase === "flagged" || !s.isOriginal) ||
    screening.length > 1;

  const formatDate = (iso: string | null) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const handleExport = () => {
    const exportRows: UserActivityEntry[] = [
      ...localEntries,
      ...strategies.map((s) => ({
        id: `strategy-${s.id}`,
        kind: "strategy" as const,
        timestamp: s.created_at,
        token: s.asset_in,
        amount: s.amount,
        txHash: s.tx_hash,
        status: s.status,
        strategyId: s.id,
        label: `${s.amount} ${s.asset_in} → ${s.asset_out} (${s.strategy_type})`,
      })),
    ];
    exportUserActivitiesCsv(walletAddress, exportRows);
  };

  return (
    <div className="userdash-activity">
      <p className="userdash-activity-privacy">
        Private to your wallet on this device — not visible to other users.
      </p>

      <div className="userdash-activity-toolbar">
        <div className="userdash-activity-filters" role="tablist" aria-label="Activity filter">
          {(
            [
              ["all", "All"],
              ["deposits", "Deposits"],
              ["withdrawals", "Withdraws"],
              ["strategies", "Strategies"],
              ["live", "Live"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={`userdash-activity-filter${filter === key ? " active" : ""}`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="userdash-activity-actions">
          {connectedRqTotal > 0 && (
            <button
              type="button"
              className="userdash-activity-ragequit-all"
              onClick={() => void handleRagequitAll()}
              disabled={ragequitLocked || ragequitAllBusy}
              title="Ragequit all flagged funds to this wallet (all at once)"
            >
              {ragequitAllBusy ? "Ragequitting…" : "Ragequit all"}
            </button>
          )}
          {connectedRqTotal > 0 && (
            <button
              type="button"
              className="userdash-activity-help"
              onClick={() => setShowRqHelp((v) => !v)}
              aria-expanded={showRqHelp}
              title="What is ragequit?"
            >
              ?
            </button>
          )}
          {showRecoverAll && (
            <button
              type="button"
              className="userdash-activity-recover-all"
              onClick={() => void handleRecoverAll()}
              disabled={ragequitLocked}
              title="Recover all rejected funds (including change notes)"
            >
              {recoverAllBusy ? "Recovering…" : "Recover all"}
            </button>
          )}
          <button
            type="button"
            className="userdash-activity-export"
            onClick={handleExport}
            title="Export CSV"
          >
            CSV
          </button>
          <button
            type="button"
            className="userdash-activity-refresh"
            onClick={() => void refresh()}
            disabled={loading}
            title="Refresh activity"
          >
            {loading ? "…" : "↻"}
          </button>
        </div>
      </div>

      {showRqHelp && (
        <div className="userdash-ragequit-help" role="note">
          <strong>What is ragequit?</strong> When a deposit fails screening, its funds are flagged and
          can no longer be spent privately. <em>Ragequit</em> returns them — publicly, on-chain — to the
          original depositing wallet. It’s all-or-nothing: every flagged note is recovered in one batch,
          so no flagged (dirty) funds stay in the shielded pool.
        </div>
      )}

      {error && (
        <p className="userdash-activity-error">
          {error}
          <span className="userdash-activity-error-hint">
            {" "}
            Local deposits and withdrawals still appear below.
          </span>
        </p>
      )}

      <div className="userdash-activity-list">
        {loading && rows.length === 0 && !error && (
          <p className="userdash-activity-empty">Loading activity…</p>
        )}

        {!loading && rows.length === 0 && !error && (
          <p className="userdash-activity-empty">
            No activity yet. Deposits, withdrawals, and strategy runs will show up here.
          </p>
        )}

        {rows.map((row) => (
          <article
            key={row.id}
            className={`userdash-activity-item status-${row.statusClass}${row.isActive ? " is-active" : ""}`}
          >
            <div className="userdash-activity-item-top">
              <div className="userdash-activity-item-main">
                <span className="userdash-activity-item-title">{row.title}</span>
                <span className="userdash-activity-item-type">{row.subtitle}</span>
              </div>
              <div className="userdash-activity-item-flags">
                {statusBadge(row)}
                {canRagequitRow(row) && (
                  <button
                    type="button"
                    className="userdash-activity-ragequit"
                    disabled={ragequitLocked}
                    title={ragequitBusyKey === row.noteKey ? "Ragequitting…" : "Ragequit"}
                    aria-label={ragequitBusyKey === row.noteKey ? "Ragequitting" : "Ragequit"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleRagequit(row);
                    }}
                  >
                    <IconDoorExit />
                  </button>
                )}
                {showReceipt(row) && (
                  <button
                    type="button"
                    className="userdash-activity-receipt"
                    title={isAdmitted(row) ? "Receipt" : "Receipt available after admit"}
                    aria-label={isAdmitted(row) ? "Receipt" : "Receipt available after admit"}
                    disabled={!isAdmitted(row)}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isAdmitted(row)) return;
                      setReceiptFor({
                        kind: row.kind as "deposit" | "withdraw",
                        amount: row.amount,
                        token: row.token,
                        chain_id: row.chainId,
                        tx_hash: row.txHash ?? undefined,
                        occurred_at: row.timestamp,
                      });
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 2v20l2.5-1.5L9 22l2.5-1.5L14 22l2.5-1.5L19 22V2l-2.5 1.5L14 2l-2.5 1.5L9 2 6.5 3.5 4 2z" />
                      <path d="M8 8h8M8 12h8M8 16h5" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            <div className="userdash-activity-item-meta">
              <div className="userdash-activity-meta-left">
                <span>{formatDate(row.timestamp)}</span>
                {chainBadge(row.chainId) && (
                  <span className="userdash-activity-chain">{chainBadge(row.chainId)}</span>
                )}
                {row.txHash && (
                  <TxChip
                    hash={row.txHash}
                    chainId={row.chainId}
                    title={row.relatedTxHash ? `Deposit ${row.txHash}` : row.txHash}
                  />
                )}
                {row.relatedTxHash &&
                  row.relatedTxHash.toLowerCase() !== (row.txHash ?? "").toLowerCase() && (
                  <TxChip
                    hash={row.relatedTxHash}
                    chainId={row.chainId}
                    title={`Ragequit ${row.relatedTxHash}`}
                    variant="ragequit"
                  />
                )}
              </div>
              {row.kind === "strategy" && row.isActive && (
                <div className="userdash-activity-meta-right">
                  <button
                    type="button"
                    className="userdash-activity-abort"
                    disabled={abortingId === row.id.slice("strategy-".length)}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleAbort(row.id.slice("strategy-".length), row.chainId);
                    }}
                  >
                    {abortingId === row.id.slice("strategy-".length) ? "Aborting…" : "Abort & reclaim"}
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>

      {receiptFor && <ReceiptModal prefill={receiptFor} onClose={() => setReceiptFor(null)} />}
    </div>
  );
}
