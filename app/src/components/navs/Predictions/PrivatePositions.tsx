"use client";

import { useCallback, useEffect, useState } from "react";
import { showAppToast } from "@/lib/appToast";
import { getSigner } from "@/lib/nexus";
import {
  fetchPolymarketPositions,
  exitPolymarketPosition,
  type PolymarketPosition,
} from "@/lib/polymarketPositions";
import "./PrivatePositions.css";

const OPEN_STATES = new Set(["OPEN", "REDEEMING"]);
const POLL_MS = 30_000;

const hex = (h: string) => (h.startsWith("0x") ? h : `0x${h}`);
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

/** The position's on-chain/CLOB breadcrumbs, in lifecycle order. Bridge + settle live on Base
 * (the funding vault chain), redeem on Polygon; entry/sell references are CLOB order ids
 * (no public explorer — shown truncated, full id on hover). */
function txLinks(p: PolymarketPosition): { label: string; href?: string; value: string }[] {
  const out: { label: string; href?: string; value: string }[] = [];
  if (p.slug)
    out.push({ label: "polymarket", value: p.slug, href: `https://polymarket.com/market/${p.slug}` });
  if (p.entry_tx) out.push({ label: "order", value: p.entry_tx });
  if (p.bridge_tx)
    out.push({ label: "bridge", value: p.bridge_tx, href: `https://basescan.org/tx/${hex(p.bridge_tx)}` });
  if (p.redeem_tx)
    out.push(
      p.status === "CLOSED"
        ? { label: "sell order", value: p.redeem_tx } // early exit: CLOB order id, not a tx
        : { label: "redeem", value: p.redeem_tx, href: `https://polygonscan.com/tx/${hex(p.redeem_tx)}` },
    );
  if (p.settle_tx)
    out.push({ label: "shielded", value: p.settle_tx, href: `https://basescan.org/tx/${hex(p.settle_tx)}` });
  return out;
}

function statusLabel(s: PolymarketPosition["status"]): { text: string; cls: string } {
  switch (s) {
    case "OPEN": return { text: "Open", cls: "pp-st--open" };
    case "REDEEMING": return { text: "Settling", cls: "pp-st--pending" };
    case "SETTLED": return { text: "Resolved", cls: "pp-st--done" };
    case "CLOSED": return { text: "Closed early", cls: "pp-st--done" };
    default: return { text: s, cls: "pp-st--fail" };
  }
}

/**
 * The user's private prediction-market positions, with an early-close action. Closing sells the
 * outcome shares on the CLOB before resolution and shields the proceeds back to the vault
 * (see lib/polymarketPositions + the executor's /polymarket/exit).
 */
export default function PrivatePositions() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [positions, setPositions] = useState<PolymarketPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);

  const load = useCallback(async (addr: string) => {
    setLoading(true);
    try {
      setPositions(await fetchPolymarketPositions(addr));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = getSigner();
      const addr = s ? await s.getAddress().catch(() => null) : null;
      if (cancelled || !addr) return;
      setWallet(addr);
      void load(addr);
    })();
    return () => { cancelled = true; };
  }, [load]);

  // Refresh when a new bet is submitted so a freshly-armed strategy shows up once it fires.
  useEffect(() => {
    const onSubmit = () => { if (wallet) void load(wallet); };
    window.addEventListener("siphon:strategySubmitted", onSubmit);
    return () => window.removeEventListener("siphon:strategySubmitted", onSubmit);
  }, [wallet, load]);

  // Live tracking: entry (withdraw→bridge→order) and settlement land minutes apart — poll so
  // hashes and status flips show up without a manual refresh.
  useEffect(() => {
    if (!wallet) return;
    const iv = setInterval(() => void load(wallet), POLL_MS);
    return () => clearInterval(iv);
  }, [wallet, load]);

  const close = async (pos: PolymarketPosition) => {
    if (!wallet) return;
    setClosing(pos.id);
    try {
      const r = await exitPolymarketPosition(wallet, pos.id, 1);
      if (r.success) {
        showAppToast("Position closed — proceeds shielding back to your vault.", "success", 6000);
        await load(wallet);
      } else {
        showAppToast(r.error || "Close failed.", "error", 7000);
      }
    } finally {
      setClosing(null);
    }
  };

  if (!wallet || (!loading && positions.length === 0)) return null;

  return (
    <div className="pp-wrap">
      <div className="pp-head">
        <span className="pp-title">My Private Positions</span>
        <button className="pp-refresh" onClick={() => wallet && load(wallet)} disabled={loading}>
          {loading ? "…" : "↻"}
        </button>
      </div>
      <div className="pp-list">
        {positions.map((p) => {
          const st = statusLabel(p.status);
          const isOpen = OPEN_STATES.has(p.status);
          const odds = p.entry_odds != null ? `${Math.round(p.entry_odds * 100)}¢` : "—";
          const payout = p.payout_usdc ? (Number(p.payout_usdc) / 1e6).toFixed(2) : null;
          return (
            <div key={p.id} className="pp-row">
              <div className="pp-row-main">
                <span className="pp-outcome">{p.outcome || p.token_id.slice(0, 8)}</span>
                <span className={`pp-st ${st.cls}`}>{st.text}</span>
              </div>
              <div className="pp-row-sub">
                <span>{p.side} @ {odds}</span>
                {p.shares && <span>{Number(p.shares).toFixed(1)} shares</span>}
                {payout && <span className="pp-payout">+${payout}</span>}
              </div>
              {txLinks(p).length > 0 && (
                <div className="pp-row-txs">
                  {txLinks(p).map((t) =>
                    t.href ? (
                      <a key={t.label} className="pp-tx" href={t.href} target="_blank"
                         rel="noopener noreferrer" title={t.value}>
                        {t.label} ↗
                      </a>
                    ) : (
                      <span key={t.label} className="pp-tx pp-tx--plain" title={t.value}>
                        {t.label} {short(t.value)}
                      </span>
                    ),
                  )}
                </div>
              )}
              {isOpen && (
                <button
                  className="pp-close"
                  onClick={() => void close(p)}
                  disabled={closing === p.id || p.status === "REDEEMING"}
                >
                  {closing === p.id ? "Closing…" : "Close position"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
