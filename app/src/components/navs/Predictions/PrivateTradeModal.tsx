"use client";

import { useMemo, useState } from "react";
import type { PolymarketMarket } from "@/app/api/polymarket/markets/route";
import { FEE, executionFeeUsd } from "@/lib/feeModel";
import { showAppToast } from "@/lib/appToast";
import { submitPolymarketBet } from "@/lib/polymarketSubmit";
import "./PrivateTradeModal.css";

interface Props {
  market: PolymarketMarket;
  onClose: () => void;
}

/**
 * Frontend private-trade flow for a Polymarket market: outcome, amount, encrypted odds trigger,
 * privacy + fee breakdown. Confirm builds the ZK note proof + winnings note, FHE-encrypts the
 * odds trigger, and submits a POLYMARKET strategy (polymarketSubmit.ts) — the executor runs the
 * shielded entry → Polygon bridge → CLOB order when the trigger fires.
 */
export default function PrivateTradeModal({ market, onClose }: Props) {
  const [outcomeIdx, setOutcomeIdx] = useState(0);
  const [amount, setAmount] = useState("");
  const [triggerMode, setTriggerMode] = useState<"now" | "threshold">("now");
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [threshold, setThreshold] = useState(String(Math.round((market.odds?.[0] ?? 0) * 100)));
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);

  const odds = market.odds?.[outcomeIdx] ?? 0;
  const oddsPct = Math.round(odds * 100);
  const amountUsd = parseFloat(amount) || 0;

  // Prediction-market payout: $amount buys amount/price shares; each share pays $1 if the outcome
  // resolves true. Potential return = amount/price.
  const shares = odds > 0 ? amountUsd / odds : 0;
  const payout = shares; // shares × $1
  const profit = payout - amountUsd;

  // Single fee, taken once when the bet actually fills (no upfront arming, no window).
  const fee = useMemo(() => executionFeeUsd(amountUsd), [amountUsd]);

  const canSubmit = amountUsd > 0 && !submitting;

  const confirm = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setPhase("Preparing…");
    try {
      const result = await submitPolymarketBet({
        market,
        outcomeIdx,
        amountUsd,
        trigger:
          triggerMode === "now"
            ? { mode: "now" }
            : { mode: "threshold", direction, oddsPct: parseFloat(threshold) || 0 },
        cb: {
          onProof: () => setPhase("Generating ZK proof…"),
          onKeygen: () => setPhase("Generating FHE keys (one-time)…"),
          onUploadKey: () => setPhase("Uploading FHE server key…"),
          onEncrypt: () => setPhase("Encrypting your trigger…"),
        },
      });
      if (result.success) {
        showAppToast(
          `Private bet armed: ${market.outcomes?.[outcomeIdx]} · $${amountUsd.toFixed(2)}. ` +
            (triggerMode === "now"
              ? "Executes on the next cycle."
              : `Fires when odds ${direction === "above" ? "rise above" : "fall below"} ${threshold}%.`),
          "success",
          7000,
        );
        window.dispatchEvent(
          new CustomEvent("siphon:strategySubmitted", {
            detail: { strategyId: String(result.data?.strategy_id ?? "") },
          }),
        );
        onClose();
      } else {
        showAppToast(result.error || "Private bet failed to submit.", "error", 8000);
      }
    } catch (e) {
      showAppToast(e instanceof Error ? e.message : "Private bet failed to submit.", "error", 8000);
    } finally {
      setSubmitting(false);
      setPhase(null);
    }
  };

  return (
    <div className="ptm-overlay" onClick={onClose}>
      <div className="ptm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ptm-head">
          <span className="ptm-badge">PRIVATE ORDER · POLYMARKET</span>
          <button className="ptm-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="ptm-market">
          {market.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="ptm-market-img" src={market.image} alt="" />
          ) : (
            <div className="ptm-market-img ptm-market-img--ph" />
          )}
          <h3 className="ptm-market-q">{market.question}</h3>
        </div>

        {/* Outcome — binary markets keep the YES/NO colouring; multi-outcome (neg-risk) markets
            list every outcome the market exposes. */}
        <label className="ptm-label">Outcome</label>
        <div className={`ptm-outcomes ${market.outcomes.length > 2 ? "ptm-outcomes--multi" : ""}`}>
          {market.outcomes.map((o, i) => {
            const binaryClass =
              market.outcomes.length === 2 ? (i === 0 ? "ptm-outcome--yes" : "ptm-outcome--no") : "";
            return (
              <button
                key={`${o}-${i}`}
                className={`ptm-outcome ${outcomeIdx === i ? "ptm-outcome--on" : ""} ${binaryClass}`}
                onClick={() => setOutcomeIdx(i)}
                disabled={!market.clobTokenIds?.[i]}
              >
                <span className="ptm-outcome-name">{o}</span>
                <span className="ptm-outcome-odds">{Math.round((market.odds?.[i] ?? 0) * 100)}%</span>
              </button>
            );
          })}
        </div>

        {/* Amount */}
        <label className="ptm-label">Amount (USDC, from your shielded vault)</label>
        <div className="ptm-amount">
          <input
            className="ptm-amount-input"
            type="number"
            min="0"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <span className="ptm-amount-tok">USDC</span>
        </div>
        {amountUsd > 0 && (
          <div className="ptm-payout">
            Buys {shares.toFixed(2)} shares @ {oddsPct}¢ · pays{" "}
            <span className="ptm-payout-win">${payout.toFixed(2)}</span> if{" "}
            {market.outcomes?.[outcomeIdx]} (
            <span className={profit >= 0 ? "ptm-payout-win" : "ptm-payout-loss"}>
              {profit >= 0 ? "+" : ""}${profit.toFixed(2)}
            </span>
            )
          </div>
        )}

        {/* Trigger */}
        <label className="ptm-label">Trigger (your thesis — encrypted, private)</label>
        <div className="ptm-trigger-modes">
          <button
            className={`ptm-mode ${triggerMode === "now" ? "ptm-mode--on" : ""}`}
            onClick={() => setTriggerMode("now")}
          >
            Execute now
          </button>
          <button
            className={`ptm-mode ${triggerMode === "threshold" ? "ptm-mode--on" : ""}`}
            onClick={() => setTriggerMode("threshold")}
          >
            When odds cross…
          </button>
        </div>
        {triggerMode === "threshold" && (
          <div className="ptm-threshold">
            <span>Fire when {market.outcomes?.[outcomeIdx]} odds</span>
            <select value={direction} onChange={(e) => setDirection(e.target.value as "above" | "below")}>
              <option value="above">rise above</option>
              <option value="below">fall below</option>
            </select>
            <input
              type="number"
              min="0"
              max="100"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <span>%</span>
          </div>
        )}

        {/* Privacy */}
        <div className="ptm-privacy">
          <div className="ptm-priv-row"><span>Funder</span><span className="ptm-priv-on">🔒 Hidden (ZK)</span></div>
          <div className="ptm-priv-row"><span>Thesis / trigger</span><span className="ptm-priv-on">🔒 Hidden (FHE)</span></div>
          <div className="ptm-priv-row"><span>Winnings</span><span className="ptm-priv-on">🔒 Shielded to vault</span></div>
          <div className="ptm-priv-row"><span>Order on Polymarket</span><span className="ptm-priv-off">Public</span></div>
        </div>

        {/* Cost — a single fee, charged only when the bet fills */}
        <div className="ptm-cost">
          <div className="ptm-cost-row"><span>Siphon fee (on fill)</span><span>${fee.toFixed(2)}</span></div>
          <div className="ptm-cost-row ptm-cost-row--sub">
            <span>{(FEE.EXEC_BPS / 100).toFixed(2)}% of trade · no minimum · no upfront fee</span>
            <span />
          </div>
        </div>

        <button className="ptm-confirm" onClick={() => void confirm()} disabled={!canSubmit}>
          {submitting ? (phase ?? "Submitting…") : amountUsd > 0 ? "Place Private Bet" : "Enter an amount"}
        </button>
        <p className="ptm-note">
          Funds leave your shielded Base vault only when the trigger fires: withdraw → bridge to
          Polygon → CLOB order. Winnings auto-shield back to your vault after resolution.
        </p>
      </div>
    </div>
  );
}
