"use client";

import { useCallback, useEffect, useState } from "react";
import {
  abortStrategy,
  formatStrategyStatus,
  getExplorerTxUrl,
  getStrategies,
  isActiveStatus,
  isExecutorUnreachableError,
  StrategyRecord,
} from "@/lib/strategyApi";
import { resolveWalletAddress } from "@/lib/walletAddress";
import { getSigner } from "@/lib/nexus";
import { showAppToast } from "@/lib/appToast";
import { bridgeDest, bridgeStatusText, lifiScanUrl } from "@/lib/bridge/hub";

interface StrategiesListProps {
  isLoaded?: boolean;
}

export default function StrategiesList({ isLoaded = true }: StrategiesListProps) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [strategies, setStrategies] = useState<StrategyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "done">("all");
  const [abortingId, setAbortingId] = useState<string | null>(null);

  const handleAbort = useCallback(async (strategyId: string, chainId?: number) => {
    // A Devnet order belongs to a Phantom wallet and aborts with its Phantom session; its input
    // notes come back on the next balance refresh, once the executor reports it ABORTED.
    if (walletAddress && !walletAddress.startsWith("0x")) {
      setAbortingId(strategyId);
      try {
        const { abortSolanaDevnetOrder } = await import("@/lib/chains/solanaDevnetStrategy");
        const res = await abortSolanaDevnetOrder(strategyId);
        if (res.ok) {
          showAppToast("Order aborted — its funds return to your Devnet vault", "success");
          setStrategies((prev) => prev.map((s) => (s.id === strategyId ? { ...s, status: "ABORTED" as StrategyRecord["status"] } : s)));
        } else {
          showAppToast(res.error || "Failed to abort", "error");
        }
      } finally {
        setAbortingId(null);
      }
      return;
    }
    const signer = getSigner();
    if (!signer) { showAppToast("Connect your wallet to abort", "error"); return; }
    setAbortingId(strategyId);
    try {
      const res = await abortStrategy(signer, strategyId, chainId);
      if (res.success) {
        const asset = res.assetIn ?? "";
        const fmt = (n?: number) => (typeof n === "number" ? `${+n.toFixed(6)} ${asset}`.trim() : "");
        const msg =
          res.strategyStatus === "PARTIALLY_EXECUTED"
            ? `Strategy stopped — ${fmt(res.spentAmount)} already executed, ${fmt(res.returnedAmount)} restored to your balance`
            : `Strategy aborted — ${fmt(res.returnedAmount)} restored to your balance`;
        showAppToast(msg, "success");
        // Reflect the new status immediately; the poll will confirm.
        setStrategies((prev) =>
          prev.map((s) => (s.id === strategyId ? { ...s, status: (res.strategyStatus as StrategyRecord["status"]) ?? "ABORTED" } : s)),
        );
      } else if (res.processing) {
        showAppToast(
          "This strategy is already executing on-chain and can no longer be cancelled.",
          "info",
        );
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
  }, [walletAddress]);

  useEffect(() => {
    const sync = () => setWalletAddress(resolveWalletAddress());
    sync();
    window.addEventListener("walletConnected", sync);
    window.addEventListener("walletDisconnected", sync);
    const poll = setInterval(sync, 2000);
    return () => {
      window.removeEventListener("walletConnected", sync);
      window.removeEventListener("walletDisconnected", sync);
      clearInterval(poll);
    };
  }, []);

  const fetchStrategies = useCallback(async () => {
    const userId = walletAddress ?? resolveWalletAddress();
    if (!userId) return;

    setLoading(true);
    setError(null);
    try {
      const result = await getStrategies(userId);
      if (result.success && result.strategies) {
        // Read-only status view: strategies are evaluated/executed server-side.
        setStrategies(result.strategies);
      } else if (result.error && !isExecutorUnreachableError(result.error)) {
        setError(result.error);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (!isExecutorUnreachableError(message)) setError(message);
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (!walletAddress) return;
    void fetchStrategies();
    const interval = setInterval(() => void fetchStrategies(), 8_000);
    const onExecuted = () => void fetchStrategies();
    window.addEventListener("siphon:strategyExecuted", onExecuted);
    return () => {
      clearInterval(interval);
      window.removeEventListener("siphon:strategyExecuted", onExecuted);
    };
  }, [walletAddress, fetchStrategies]);

  const formatDate = (iso: string | null) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString();
  };

  const filtered = strategies.filter((s) => {
    if (filter === "active") return isActiveStatus(s.status);
    if (filter === "done") return s.status === "EXECUTED" || s.status === "FAILED";
    return true;
  });

  if (!isLoaded) return null;

  if (!walletAddress) {
    return (
      <div className="run-mode-empty">
        <p className="run-mode-empty-title">Connect your wallet</p>
        <p className="run-mode-empty-hint">Your submitted strategies will appear here</p>
      </div>
    );
  }

  return (
    <div className="run-backend-panel">
      <div className="run-backend-toolbar">
        <div className="run-mode-view-switcher">
          {(["all", "active", "done"] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={`run-mode-view-btn ${filter === key ? "active" : ""}`}
              onClick={() => setFilter(key)}
            >
              {key === "all" ? "All" : key === "active" ? "In progress" : "Completed"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="run-backend-refresh"
          onClick={() => void fetchStrategies()}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <div className="run-backend-error">{error}</div>}

      {loading && strategies.length === 0 && !error && (
        <div className="run-mode-empty">
          <p className="run-mode-empty-title">Loading strategies…</p>
        </div>
      )}

      {!loading && filtered.length === 0 && !error && (
        <div className="run-mode-empty">
          <p className="run-mode-empty-title">No runs yet</p>
          <p className="run-mode-empty-hint">
            Run a strategy from Discover or Build — it will show up here with live status
          </p>
        </div>
      )}

      <div className="run-backend-list">
        {filtered.map((s) => (
          <div
            key={s.id}
            className={`run-backend-card ${isActiveStatus(s.status) ? "active" : ""} status-${s.status.toLowerCase()}`}
          >
            <div className="run-backend-card-header">
              <div>
                <h3 className="run-backend-card-title">
                  {s.amount} {s.asset_in} → {s.asset_out}
                </h3>
                <p className="run-backend-card-sub">
                  {s.strategy_type.replace(/_/g, " ")}
                  {s.strategy_type === "PIPELINE" && s.leg_count
                    ? ` · hop ${Math.min((s.executed_count ?? s.zkp_data?.hop_cursor ?? 0) + (s.status === "EXECUTED" ? 0 : 1), s.leg_count)}/${s.leg_count}`
                    : ""}
                  {" "}· ID {s.id.slice(0, 8)}…
                </p>
              </div>
              <span className={`run-status-badge status-${s.status.toLowerCase()}`}>
                {isActiveStatus(s.status) && <span className="status-dot" />}
                {formatStrategyStatus(s.status)}
              </span>
            </div>

            <div className="run-backend-meta">
              <div className="run-backend-meta-row">
                <span className="run-backend-meta-label">Created</span>
                <span className="run-backend-meta-value">{formatDate(s.created_at)}</span>
              </div>
              {s.result_updated_at && (
                <div className="run-backend-meta-row">
                  <span className="run-backend-meta-label">Last evaluated</span>
                  <span className="run-backend-meta-value">{formatDate(s.result_updated_at)}</span>
                </div>
              )}
              {s.executed_at && (
                <div className="run-backend-meta-row">
                  <span className="run-backend-meta-label">Executed</span>
                  <span className="run-backend-meta-value">{formatDate(s.executed_at)}</span>
                </div>
              )}
            </div>

            {s.tx_hash && (
              <div className="run-backend-tx">
                <span className="run-backend-meta-label">Transaction</span>
                <a
                  href={getExplorerTxUrl(s.tx_hash, s.from_chain)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="run-backend-tx-link"
                >
                  {s.tx_hash.slice(0, 10)}…{s.tx_hash.slice(-8)} ↗
                </a>
              </div>
            )}

            {s.payout && (
              <div className="run-backend-tx">
                <span className="run-backend-meta-label">
                  Payout to {bridgeDest(s.payout.to_chain_id)?.label ?? s.payout.to_chain_id}
                </span>
                {s.payout_order?.bridge_tx ? (
                  <a href={lifiScanUrl(s.payout_order.bridge_tx)} target="_blank" rel="noopener noreferrer"
                     className="run-backend-tx-link">
                    {bridgeStatusText(s.payout_order)} ↗
                  </a>
                ) : (
                  <span className="run-backend-meta-value">
                    {s.payout_order ? bridgeStatusText(s.payout_order) : "When it fires"}
                  </span>
                )}
              </div>
            )}

            {/* Abort only shows on unfired strategies (PENDING/ARMED). The executor refuses
                anything already on-chain, so this is safe even if the status is momentarily stale. */}
            {isActiveStatus(s.status) && (
              <button
                type="button"
                className="run-backend-abort-btn"
                disabled={abortingId === s.id}
                onClick={() => handleAbort(s.id, Number(s.from_chain) || undefined)}
              >
                {abortingId === s.id ? "Aborting…" : "Abort & reclaim funds"}
              </button>
            )}

          </div>
        ))}
      </div>
    </div>
  );
}
