"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatStrategyStatus,
  getExplorerTxUrl,
  getStrategies,
  isActiveStatus,
  isExecutorUnreachableError,
  type StrategyRecord,
} from "@/lib/strategyApi";
import { isQuickSwapStrategy } from "@/lib/quickSwapStrategyIds";
import { resolveWalletAddress } from "@/lib/walletAddress";
import { StrategyDetailModal } from "@/components/widgets/primitives/StrategyDetailModal";

const STATUS_POLL_MS = 5_000;
/** Always keep this many recent runs in the widget so it doesn’t go empty after finishes. */
const PINNED_RUNS = 4;

function runsCacheKey(wallet: string): string {
  return `siphon.runsWidget.v1.${wallet.toLowerCase()}`;
}

function runRecency(s: StrategyRecord): number {
  const ts = s.result_updated_at ?? s.executed_at ?? s.created_at;
  const t = ts ? new Date(ts).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

function pickPinnedRuns(rows: StrategyRecord[], limit = PINNED_RUNS): StrategyRecord[] {
  return [...rows]
    .filter((s) => !isQuickSwapStrategy(s.id))
    .sort((a, b) => runRecency(b) - runRecency(a))
    .slice(0, limit);
}

function readCachedRuns(wallet: string): StrategyRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(runsCacheKey(wallet));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return pickPinnedRuns(parsed as StrategyRecord[]);
  } catch {
    return [];
  }
}

function writeCachedRuns(wallet: string, rows: StrategyRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(runsCacheKey(wallet), JSON.stringify(pickPinnedRuns(rows)));
  } catch {
    /* quota / private mode */
  }
}

/** Prefer fresh API rows; fill remaining slots from cache so brief empty polls don’t wipe the board. */
function mergePinnedRuns(fresh: StrategyRecord[], cached: StrategyRecord[]): StrategyRecord[] {
  const byId = new Map<string, StrategyRecord>();
  for (const s of fresh) {
    if (!isQuickSwapStrategy(s.id)) byId.set(s.id, s);
  }
  for (const s of cached) {
    if (!isQuickSwapStrategy(s.id) && !byId.has(s.id)) byId.set(s.id, s);
  }
  return pickPinnedRuns([...byId.values()]);
}

function openUserDashActivity() {
  window.dispatchEvent(new CustomEvent("userdash-view-change", { detail: "userdash" }));
  window.dispatchEvent(new CustomEvent("pro-view-mode-change", { detail: "userdash" }));
  window.dispatchEvent(
    new CustomEvent("siphon:activityLogFilter", { detail: { filter: "live" } }),
  );
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function LiveStrategyItem({
  strategy,
  compact,
  onClick,
}: {
  strategy: StrategyRecord;
  compact?: boolean;
  onClick: () => void;
}) {
  const statusClass = strategy.status.toLowerCase();

  return (
    <li>
      <button
        type="button"
        className={`widget-runs-strategy-item${compact ? " widget-runs-strategy-item--compact" : ""}`}
        onClick={onClick}
      >
        <div className="widget-runs-strategy-top">
          <div className="widget-runs-strategy-main">
            <span className="widget-runs-strategy-title">
              {strategy.amount} {strategy.asset_in} → {strategy.asset_out}
            </span>
            <span className="widget-runs-strategy-type">
              {strategy.strategy_type.replace(/_/g, " ")}
              {strategy.strategy_type === "PIPELINE" && strategy.leg_count
                ? ` · hop ${Math.min((strategy.executed_count ?? 0) + (strategy.status === "EXECUTED" ? 0 : 1), strategy.leg_count)}/${strategy.leg_count}`
                : ""}
            </span>
          </div>
          <span className={`widget-runs-badge status-${statusClass}`}>
            {isActiveStatus(strategy.status) && <span className="widget-runs-dot" aria-hidden />}
            {formatStrategyStatus(strategy.status)}
          </span>
        </div>
        {!compact && (
          <div className="widget-runs-strategy-meta">
            <span>{formatDate(strategy.result_updated_at ?? strategy.created_at)}</span>
            {strategy.tx_hash && (
              <a
                href={getExplorerTxUrl(strategy.tx_hash, strategy.from_chain)}
                target="_blank"
                rel="noopener noreferrer"
                className="widget-runs-strategy-tx"
                onClick={(e) => e.stopPropagation()}
              >
                tx ↗
              </a>
            )}
          </div>
        )}
      </button>
    </li>
  );
}

export function RunsPanel({ compact = false }: { compact?: boolean }) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [strategies, setStrategies] = useState<StrategyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyRecord | null>(null);
  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const cacheRef = useRef<StrategyRecord[]>([]);

  useEffect(() => {
    const sync = () => setWalletAddress(resolveWalletAddress());
    sync();
    window.addEventListener("walletConnected", sync);
    window.addEventListener("walletDisconnected", sync);
    return () => {
      window.removeEventListener("walletConnected", sync);
      window.removeEventListener("walletDisconnected", sync);
    };
  }, []);

  const applyStrategies = useCallback((rows: StrategyRecord[], wallet: string) => {
    for (const s of rows) {
      const prev = prevStatusRef.current.get(s.id);
      if (prev && prev !== s.status && (s.status === "EXECUTED" || s.status === "FAILED")) {
        window.dispatchEvent(
          new CustomEvent("siphon:strategyExecuted", { detail: { strategyId: s.id } }),
        );
      }
      prevStatusRef.current.set(s.id, s.status);
    }

    const pinned = mergePinnedRuns(rows, cacheRef.current);
    cacheRef.current = pinned;
    writeCachedRuns(wallet, pinned);
    setStrategies(pinned);
    setSelectedStrategy((current) => {
      if (!current) return null;
      const fresh = pinned.find((s) => s.id === current.id) ?? rows.find((s) => s.id === current.id);
      return fresh ?? current;
    });
  }, []);

  const fetchLiveStrategies = useCallback(
    async (silent = false) => {
      const userId = walletAddress ?? resolveWalletAddress();
      if (!userId) return;

      if (!silent) setLoading(true);

      try {
        const result = await getStrategies(userId);
        if (result.success && result.strategies) {
          // Empty success still merges with cache — don’t wipe the last 4 on a quiet board.
          applyStrategies(result.strategies, userId);
          setError(null);
        } else if (result.error) {
          if (isExecutorUnreachableError(result.error)) {
            setError(null);
          } else {
            setStrategies((prev) => {
              if (prev.length === 0) setError(result.error!);
              return prev;
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (isExecutorUnreachableError(message)) {
          setError(null);
        } else {
          setStrategies((prev) => {
            if (prev.length === 0) setError(message);
            return prev;
          });
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [walletAddress, applyStrategies],
  );

  useEffect(() => {
    if (!walletAddress) {
      setStrategies([]);
      setError(null);
      setLoading(false);
      cacheRef.current = [];
      prevStatusRef.current.clear();
      return;
    }

    // Paint last 4 immediately from local cache, then refresh from the executor.
    const cached = readCachedRuns(walletAddress);
    cacheRef.current = cached;
    if (cached.length > 0) {
      setStrategies(cached);
      setLoading(false);
    }

    void fetchLiveStrategies(cached.length > 0);

    const onStrategyEvent = () => void fetchLiveStrategies(true);
    window.addEventListener("siphon:strategySubmitted", onStrategyEvent);
    window.addEventListener("siphon:strategyExecuted", onStrategyEvent);

    return () => {
      window.removeEventListener("siphon:strategySubmitted", onStrategyEvent);
      window.removeEventListener("siphon:strategyExecuted", onStrategyEvent);
    };
  }, [walletAddress, fetchLiveStrategies]);

  useEffect(() => {
    if (!walletAddress) return;
    const interval = setInterval(
      () => void fetchLiveStrategies(true),
      strategies.length === 0 ? 8_000 : STATUS_POLL_MS,
    );
    return () => clearInterval(interval);
  }, [walletAddress, strategies.length, fetchLiveStrategies]);

  const liveStrategies = useMemo(
    () =>
      [...strategies].sort((a, b) => runRecency(b) - runRecency(a)).slice(0, PINNED_RUNS),
    [strategies],
  );

  const visibleStrategies = liveStrategies;

  const emptyMessage = !walletAddress
    ? "Connect wallet"
    : loading && liveStrategies.length === 0
      ? "Loading…"
      : "No runs yet";

  const listContent =
    error && liveStrategies.length === 0 ? (
      <p className="widget-runs-empty widget-runs-empty--error">{error}</p>
    ) : visibleStrategies.length === 0 ? (
      <p className="widget-runs-empty">{emptyMessage}</p>
    ) : (
      <ul
        className={`widget-runs-list widget-runs-list--strategies${compact ? " widget-runs-list--compact" : " widget-runs-list--scroll"}`}
      >
        {visibleStrategies.map((s) => (
          <LiveStrategyItem
            key={s.id}
            strategy={s}
            compact={compact}
            onClick={() => setSelectedStrategy(s)}
          />
        ))}
      </ul>
    );

  const footnote =
    liveStrategies.length > 0
      ? `${liveStrategies.length} recent`
      : walletAddress
        ? "Run from builder"
        : null;

  return (
    <>
      {compact ? (
        <div className="widget-hover widget-card widget-card--compact widget-card--glance widget-runs-card widget-runs-card--compact">
          <div className="widget-runs-compact-header">
            <p className="widget-card-eyebrow">Runs</p>
            {liveStrategies.length > 0 ? (
              <button type="button" className="widget-runs-open-btn" onClick={openUserDashActivity}>
                Activity
              </button>
            ) : null}
          </div>
          <div className="widget-card-body widget-runs-body widget-runs-body--compact">{listContent}</div>
          {footnote ? <p className="widget-card-footnote">{footnote}</p> : null}
        </div>
      ) : (
        <div className="widget-hover widget-card widget-runs-card">
          <div className="widget-card-header widget-card-header--compact widget-runs-card-header">
            <div>
              <p className="widget-card-title">Runs</p>
              <p className="widget-card-subtitle">Last {PINNED_RUNS} runs</p>
            </div>
            {liveStrategies.length > 0 ? (
              <button type="button" className="widget-runs-open-btn" onClick={openUserDashActivity}>
                Activity log
              </button>
            ) : null}
          </div>
          <div className="widget-runs-body widget-runs-body--full">
            {!walletAddress ? (
              <p className="widget-runs-empty widget-runs-empty--full">
                Connect your wallet to see live strategies
              </p>
            ) : (
              listContent
            )}
          </div>
        </div>
      )}

      <StrategyDetailModal strategy={selectedStrategy} onClose={() => setSelectedStrategy(null)} />
    </>
  );
}
