"use client";

/**
 * Post-ramp Tempo tools: Stablecoin DEX swap + sandbox Zone deposit.
 * Shown when the user is receiving / funding via Tempo (edge 4217).
 */
import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { showAppToast } from "@/lib/appToast";
import { displayAmount } from "@/lib/amountString";
import { quoteTempoDexSwap, swapTempoDexExactIn } from "@/lib/tempo/dex";
import {
  TEMPO_MAINNET_ID,
  tempoExplorerTx,
  tempoStableBySymbol,
  tempoStables,
} from "@/lib/tempo/tokens";
import {
  TEMPO_ZONE_PRODUCT_NOTE,
  TEMPO_ZONE_SANDBOX,
  depositToTempoZone,
} from "@/lib/tempo/zones";

type Props = {
  /** User EVM address (Tempo + Base share the address space). */
  evmAddress: string | null | undefined;
};

// The swap runs on Tempo mainnet: only the stables that exist there (Moderato's alpha/beta/theta
// do not, and offering them made every quote fail).
const DEX_STABLES = tempoStables(TEMPO_MAINNET_ID);
const PATH_USD = tempoStableBySymbol("pathUSD")!.address;

export default function TempoEdgePanel({ evmAddress }: Props) {
  const [tab, setTab] = useState<"dex" | "zone">("dex");
  const [tokenIn, setTokenIn] = useState(tempoStableBySymbol("USDC.e")!.address);
  const [tokenOut, setTokenOut] = useState(PATH_USD);
  const [amount, setAmount] = useState("10");
  const [quoteOut, setQuoteOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoneId, setZoneId] = useState(TEMPO_ZONE_SANDBOX[0].id);

  const refreshQuote = useCallback(async () => {
    try {
      const units = ethers.parseUnits((amount || "0").trim() || "0", 6);
      if (units <= 0n) {
        setQuoteOut(null);
        return;
      }
      const q = await quoteTempoDexSwap({
        tokenIn,
        tokenOut,
        amountIn: units,
        chainId: TEMPO_MAINNET_ID,
      });
      setQuoteOut(
        `≈ ${displayAmount(ethers.formatUnits(q.amountOut, q.tokenOut.decimals))} ${q.tokenOut.symbol}`,
      );
    } catch (e) {
      setQuoteOut(e instanceof Error ? e.message : "No quote");
    }
  }, [amount, tokenIn, tokenOut]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void refreshQuote();
    }, 400);
    return () => window.clearTimeout(t);
  }, [refreshQuote]);

  const onSwap = async () => {
    if (!evmAddress) {
      showAppToast("Connect an EVM wallet first.", "error");
      return;
    }
    setBusy(true);
    try {
      const units = ethers.parseUnits((amount || "0").trim(), 6);
      const q = await quoteTempoDexSwap({
        tokenIn,
        tokenOut,
        amountIn: units,
        chainId: TEMPO_MAINNET_ID,
      });
      const minOut = (q.amountOut * 98n) / 100n;
      const hash = await swapTempoDexExactIn({
        tokenIn,
        tokenOut,
        amountIn: units,
        minAmountOut: minOut,
        chainId: TEMPO_MAINNET_ID,
      });
      showAppToast(`Tempo DEX swap sent — ${hash.slice(0, 10)}…`, "success");
      window.open(tempoExplorerTx(TEMPO_MAINNET_ID, hash), "_blank", "noopener,noreferrer");
    } catch (e) {
      showAppToast(e instanceof Error ? e.message : "Swap failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const onZoneDeposit = async () => {
    if (!evmAddress) {
      showAppToast("Connect an EVM wallet first.", "error");
      return;
    }
    setBusy(true);
    try {
      const units = ethers.parseUnits((amount || "0").trim(), 6);
      // Sandbox portals sit on Moderato; pathUSD is the usual demo asset.
      const pathUsd = PATH_USD;
      const hash = await depositToTempoZone({
        zoneId,
        token: pathUsd,
        amount: units,
        to: evmAddress,
      });
      showAppToast(`Zone deposit submitted — ${hash.slice(0, 10)}…`, "success");
    } catch (e) {
      showAppToast(e instanceof Error ? e.message : "Zone deposit failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="userdash-tempo-edge" style={{ marginTop: 12 }}>
      <div className="userdash-fee-quoting" style={{ marginBottom: 8 }}>
        Tempo edge — stables ramp. DEX / Zone run on Tempo after USDC.e lands (privacy stays on Base).
      </div>
      <div className="userdash-input-group" style={{ gap: 8, marginBottom: 8 }}>
        <button
          type="button"
          className={`userdash-link-button${tab === "dex" ? " is-active" : ""}`}
          onClick={() => setTab("dex")}
        >
          Stablecoin DEX
        </button>
        <button
          type="button"
          className={`userdash-link-button${tab === "zone" ? " is-active" : ""}`}
          onClick={() => setTab("zone")}
        >
          Zone deposit
        </button>
      </div>

      <div className="userdash-input-group">
        <input
          className="userdash-input"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          aria-label="Tempo amount"
        />
      </div>

      {tab === "dex" ? (
        <>
          <div className="userdash-input-group" style={{ gap: 8 }}>
            <select
              className="userdash-select"
              value={tokenIn}
              onChange={(e) => setTokenIn(e.target.value)}
              aria-label="Token in"
            >
              {DEX_STABLES.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                </option>
              ))}
            </select>
            <select
              className="userdash-select"
              value={tokenOut}
              onChange={(e) => setTokenOut(e.target.value)}
              aria-label="Token out"
            >
              {DEX_STABLES.map((t) => (
                <option key={`out-${t.address}`} value={t.address}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </div>
          {quoteOut && <div className="userdash-fee-quoting">{quoteOut}</div>}
          <button type="button" className="userdash-button" disabled={busy} onClick={() => void onSwap()}>
            {busy ? "Swapping…" : "Swap on Tempo DEX"}
          </button>
        </>
      ) : (
        <>
          <div className="userdash-fee-quoting">{TEMPO_ZONE_PRODUCT_NOTE}</div>
          <div className="userdash-input-group">
            <select
              className="userdash-select userdash-select--grow"
              value={zoneId}
              onChange={(e) => setZoneId(Number(e.target.value))}
              aria-label="Sandbox zone"
            >
              {TEMPO_ZONE_SANDBOX.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.label}
                </option>
              ))}
            </select>
          </div>
          <div className="userdash-fee-quoting">
            Deposits pathUSD via Zone portal on Moderato (sandbox). Needs faucet funds on Moderato.
          </div>
          <button
            type="button"
            className="userdash-button"
            disabled={busy}
            onClick={() => void onZoneDeposit()}
          >
            {busy ? "Depositing…" : "Deposit to Zone (sandbox)"}
          </button>
        </>
      )}
    </div>
  );
}
