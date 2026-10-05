"use client";

import { useCallback, useEffect, useState } from "react";
import type { HlMid } from "@/app/api/hyperliquid/mids/route";
import { submitHyperliquidPerp, type HlSide } from "@/lib/hyperliquidSubmit";
import {
  exitHyperliquidPosition,
  fetchHyperliquidPositions,
  type HyperliquidPosition,
} from "@/lib/hyperliquidPositions";
import { getSigner } from "@/lib/nexus";
import "./PrivatePerps.css";

function fmtPx(n: number): string {
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

const STATUS_LABEL: Record<string, string> = {
  FUNDING: "funding (~20 min)",
  OPENING: "opening",
  OPEN: "open",
  CLOSING: "closing",
  PAYOUT_DUE: "paying out",
  PAYING: "paying out",
  SETTLED: "settled",
  REFUNDED: "refunded on Base",
  REVIEW: "under review",
};

function fmtUsdc(units?: string | null): string {
  return (Number(units || 0) / 1e6).toFixed(2);
}

function chainName(id: number): string {
  return id === 42161 ? "Arbitrum" : "Hyperliquid";
}

function positionDetail(p: HyperliquidPosition): string {
  if (p.status === "OPEN" && p.equity_usd != null) {
    const margin = Number(p.margin_usdc || 0) / 1e6;
    const pnl = p.equity_usd - margin;
    return `entry $${fmtPx(p.entry_px ?? 0)} · ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}`;
  }
  if (p.status === "SETTLED") return `paid ${fmtUsdc(p.payout_usdc)} USDC · ${chainName(p.payout_chain)}`;
  if (p.entry_px != null) return `entry $${fmtPx(p.entry_px)}`;
  return "—";
}

export default function PrivatePerps() {
  const [mids, setMids] = useState<HlMid[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<HlMid | null>(null);
  const [side, setSide] = useState<HlSide>("LONG");
  const [margin, setMargin] = useState("50");
  const [leverage, setLeverage] = useState("3");
  const [entryPx, setEntryPx] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [positions, setPositions] = useState<HyperliquidPosition[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hyperliquid/mids");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setMids(data.mids ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load markets");
      setMids([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPositions = useCallback(async () => {
    try {
      const signer = getSigner();
      if (!signer) return;
      const addr = (await signer.getAddress()).toLowerCase();
      setPositions(await fetchHyperliquidPositions(addr));
    } catch {
      /* positions optional until wallet connected / executor live */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadPositions();
    const iv = setInterval(() => {
      void load();
      void loadPositions();
    }, 20_000);
    return () => clearInterval(iv);
  }, [load, loadPositions]);

  const arm = async () => {
    if (!selected) return;
    setBusy(true);
    setMsg(null);
    const entry = parseFloat(entryPx);
    const result = await submitHyperliquidPerp({
      coin: selected.coin,
      side,
      marginUsd: parseFloat(margin) || 0,
      leverage: parseInt(leverage, 10) || 1,
      takeProfitPx: parseFloat(takeProfit) || undefined,
      stopLossPx: parseFloat(stopLoss) || undefined,
      trigger:
        entry > 0
          ? {
              mode: "threshold",
              direction: side === "LONG" ? "below" : "above",
              priceUsd: entry,
            }
          : { mode: "now" },
      cb: {
        onLog: (text) => setMsg({ kind: "ok", text }),
        onEncrypt: () => setMsg({ kind: "ok", text: "Encrypting trigger…" }),
      },
    });
    setBusy(false);
    if (result.success) {
      setMsg({
        kind: "ok",
        text: `Armed — ${side} ${selected.coin}. When it fires the margin moves to Hyperliquid (~20 min); TP/SL are watched until close.`,
      });
      setSelected(null);
      void loadPositions();
    } else {
      setMsg({ kind: "err", text: result.error || "Submit failed" });
    }
  };

  const onExit = async (id: string) => {
    try {
      setBusy(true);
      const p = await exitHyperliquidPosition(id);
      setMsg({
        kind: "ok",
        text:
          p.status === "SETTLED"
            ? `Closed — paid ${fmtUsdc(p.payout_usdc)} USDC to ${p.payout_address.slice(0, 8)}… on ${chainName(p.payout_chain)}.`
            : `Closing — ${p.status.toLowerCase().replace("_", " ")}${p.error ? `: ${p.error}` : ""}`,
      });
      void loadPositions();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Exit failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pperps">
      <header className="pperps-head">
        <p className="pperps-kicker">Hyperliquid</p>
        <h1 className="pperps-title">Private Perps</h1>
        <p className="pperps-sub">
          Margin from your Base vault, moved to Hyperliquid when your hidden trigger fires. A closed
          position pays its margin + PnL to your wallet&apos;s address on Hyperliquid.
        </p>
        <div className="pperps-chips">
          <span className="pperps-chip pperps-chip--on">Funder hidden (ZK)</span>
          <span className="pperps-chip pperps-chip--on">Trigger hidden (FHE)</span>
          <span className="pperps-chip pperps-chip--off">Order on HL: public</span>
          <span className="pperps-chip pperps-chip--off">Payout: your HL address</span>
        </div>
      </header>

      {loading && !mids.length ? (
        <div className="pperps-state">Loading marks…</div>
      ) : error ? (
        <div className="pperps-state pperps-state--err">{error}</div>
      ) : (
        <div className="pperps-list">
          {mids.map((m) => (
            <button
              key={m.coin}
              type="button"
              className="pperps-row"
              onClick={() => {
                setSelected(m);
                setMsg(null);
                setEntryPx("");
              }}
            >
              <span className="pperps-coin">{m.coin}-PERP</span>
              <span className="pperps-mid">${fmtPx(m.mid)}</span>
              <span className="pperps-go">Trade</span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="pperps-form">
          <h3>
            {side} {selected.coin} · mid ${fmtPx(selected.mid)}
          </h3>
          <div className="pperps-side">
            <button
              type="button"
              className={side === "LONG" ? "is-on" : ""}
              onClick={() => setSide("LONG")}
            >
              Long
            </button>
            <button
              type="button"
              className={`is-short${side === "SHORT" ? " is-on" : ""}`}
              onClick={() => setSide("SHORT")}
            >
              Short
            </button>
          </div>
          <div className="pperps-fields" style={{ marginTop: "0.75rem" }}>
            <label>
              Margin (USDC from vault)
              <input value={margin} onChange={(e) => setMargin(e.target.value)} inputMode="decimal" />
            </label>
            <label>
              Leverage
              <input value={leverage} onChange={(e) => setLeverage(e.target.value)} inputMode="numeric" />
            </label>
            <label>
              Entry trigger USD (blank = now)
              <input value={entryPx} onChange={(e) => setEntryPx(e.target.value)} inputMode="decimal" placeholder={String(selected.mid)} />
            </label>
            <label>
              Take profit USD (optional)
              <input value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} inputMode="decimal" />
            </label>
            <label>
              Stop loss USD (optional)
              <input value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} inputMode="decimal" />
            </label>
          </div>
          <div className="pperps-actions">
            <button type="button" className="ghost" onClick={() => setSelected(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => void arm()} disabled={busy}>
              {busy ? "Arming…" : "Arm private entry"}
            </button>
          </div>
          {msg && <p className={`pperps-msg pperps-msg--${msg.kind}`}>{msg.text}</p>}
        </div>
      )}

      {positions.length > 0 && (
        <div className="pperps-form" style={{ marginTop: "1.5rem" }}>
          <h3>Your positions</h3>
          <div className="pperps-list">
            {positions.map((p) => (
              <div key={p.id} className="pperps-row" style={{ cursor: "default" }}>
                <span className="pperps-coin">
                  {p.side} {p.coin} · {p.leverage}x · {STATUS_LABEL[p.status] ?? p.status}
                </span>
                <span className="pperps-mid" title={p.error ?? undefined}>{positionDetail(p)}</span>
                {p.status === "OPEN" ? (
                  <button
                    type="button"
                    className="pperps-go"
                    disabled={busy}
                    onClick={() => void onExit(p.id)}
                    style={{ background: "none", border: "none", cursor: "pointer" }}
                  >
                    Close
                  </button>
                ) : (
                  <span className="pperps-go">{p.status}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
