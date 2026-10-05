"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownUp, Settings } from "lucide-react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { walletManager } from "@/components/extensions/walletManager";
import { resolveWalletAddress } from "@/lib/walletAddress";
import {
  calculateNetReceiveEstimate,
  calculateRunFee,
  fetchCoinPrices,
  formatAmount,
} from "@/components/navs/Discover/price_utils";
import {
  DEFAULT_SWAP_SLIPPAGE_PCT,
  QUICK_SWAP_RUN_DURATION,
  readSwapSlippagePct,
  writeSwapSlippagePct,
} from "@/lib/quickSwapSettings";
import { executeQuickSwapPayAndRun } from "@/lib/quickSwapRun";
import { showAppToast } from "@/lib/appToast";
import { getSelectedChainId, SOLANA_DEVNET_UI_CHAIN_ID } from "@/lib/networks";

const PAIRS = ["ETH", "USDC"];
// Solana Devnet trades SOL ↔ USDC in its own vault, to a Phantom (base58) wallet.
const DEVNET_PAIRS = ["SOL", "USDC"];
const WALLET_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type SwapPanelProps = {
  compact?: boolean;
};

function SwapSettingsPopover({
  anchorRef,
  slippagePct,
  onSlippageChange,
  runFeeUsd,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  slippagePct: number;
  onSlippageChange: (pct: number) => void;
  runFeeUsd: number;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(String(slippagePct));
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const popoverWidth = 184;
    const left = Math.min(
      Math.max(8, rect.right - popoverWidth),
      window.innerWidth - popoverWidth - 8,
    );
    setPosition({ top: rect.bottom + 6, left });
  }, [anchorRef]);

  useEffect(() => {
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [updatePosition]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose, anchorRef]);

  const apply = () => {
    const n = parseFloat(draft);
    if (!Number.isFinite(n) || n < 0.01 || n > 50) {
      showAppToast("Slippage must be between 0.01% and 50%", "error");
      return;
    }
    onSlippageChange(n);
    onClose();
  };

  if (!position || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="widget-swap-settings-popover widget-swap-settings-popover--portal"
      ref={ref}
      role="dialog"
      aria-label="Swap settings"
      style={{ top: position.top, left: position.left }}
    >
      <p className="widget-swap-settings-title">Swap settings</p>
      <label className="widget-swap-settings-label">
        Max slippage (%)
        <input
          type="text"
          inputMode="decimal"
          className="widget-swap-settings-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <p className="widget-swap-settings-hint">
        Est. receive uses spot rate − slippage − run fee (${runFeeUsd.toFixed(2)}).
      </p>
      <button type="button" className="widget-swap-settings-save" onClick={apply}>
        Save
      </button>
    </div>,
    document.body,
  );
}

export function SwapPanel({ compact = false }: SwapPanelProps) {
  const devnet = getSelectedChainId() === SOLANA_DEVNET_UI_CHAIN_ID;
  const pairs = devnet ? DEVNET_PAIRS : PAIRS;
  const [from, setFrom] = useState<string>(pairs[0]);
  const [to, setTo] = useState<string>("USDC");
  useEffect(() => {
    setFrom(devnet ? "SOL" : "ETH");
    setTo("USDC");
  }, [devnet]);
  const [amount, setAmount] = useState("");
  const [destinationWallet, setDestinationWallet] = useState("");
  const [slippagePct, setSlippagePct] = useState(DEFAULT_SWAP_SLIPPAGE_PCT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [coinPrices, setCoinPrices] = useState<Record<string, number>>({});
  const [pricesLoaded, setPricesLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const runFeeUsd = useMemo(() => calculateRunFee(QUICK_SWAP_RUN_DURATION), []);

  useEffect(() => {
    setSlippagePct(readSwapSlippagePct());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const prices = await fetchCoinPrices();
      if (!cancelled) {
        setCoinPrices(prices);
        setPricesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const syncWallet = () => {
      const connected = resolveWalletAddress();
      setDestinationWallet((prev) => (prev.trim() ? prev : connected ?? ""));
    };
    syncWallet();
    window.addEventListener("walletConnected", syncWallet);
    window.addEventListener("walletDisconnected", syncWallet);
    return () => {
      window.removeEventListener("walletConnected", syncWallet);
      window.removeEventListener("walletDisconnected", syncWallet);
    };
  }, []);

  const flip = () => {
    setFrom(to);
    setTo(from);
  };

  const inputAmount = parseFloat(amount) || 0;
  const estimatedOut = useMemo(() => {
    if (inputAmount <= 0 || !pricesLoaded) return 0;
    return calculateNetReceiveEstimate(
      inputAmount,
      from,
      to,
      coinPrices,
      slippagePct,
      runFeeUsd,
    );
  }, [inputAmount, from, to, coinPrices, slippagePct, runFeeUsd, pricesLoaded]);

  const formattedEstimate =
    inputAmount > 0 && pricesLoaded ? formatAmount(estimatedOut, to) : inputAmount > 0 ? "…" : "0.00";

  const walletValid =
    !destinationWallet.trim() ||
    (devnet ? SOLANA_WALLET_PATTERN : WALLET_PATTERN).test(destinationWallet.trim());
  const canSubmit =
    inputAmount > 0 && walletValid && !busy && destinationWallet.trim().length > 0;

  const handleSlippageChange = (pct: number) => {
    setSlippagePct(pct);
    writeSwapSlippagePct(pct);
  };

  const { openConnectModal } = useConnectModal();

  /** Open RainbowKit's connect modal and wait for it to succeed (or time out / get closed). */
  const ensureWalletConnected = useCallback(async (): Promise<boolean> => {
    if (walletManager.getPrimaryWallet()?.address) return true;
    if (!openConnectModal) return false;
    openConnectModal();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("walletConnected", onConnected);
        window.clearTimeout(timer);
        resolve(ok);
      };
      const onConnected = () => finish(true);
      const timer = window.setTimeout(() => finish(false), 120_000);
      window.addEventListener("walletConnected", onConnected);
    });
  }, [openConnectModal]);

  const handlePayAndRun = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const connected = await ensureWalletConnected();
      if (!connected) {
        showAppToast("Connect your wallet to continue.", "error");
        return;
      }
      const result = await executeQuickSwapPayAndRun({
        assetIn: from,
        assetOut: to,
        amount: inputAmount,
        recipient: destinationWallet.trim(),
        slippagePct,
      });
      if (result.success) {
        showAppToast("Strategy registered — executing via Pay & Run.", "success");
        setAmount("");
      } else {
        showAppToast(result.error ?? "Pay & Run failed", "error");
      }
    } catch (e) {
      showAppToast(e instanceof Error ? e.message : "Pay & Run failed", "error");
    } finally {
      setBusy(false);
    }
  }, [canSubmit, from, to, inputAmount, destinationWallet, slippagePct, ensureWalletConnected]);

  const settingsBtnRef = useRef<HTMLButtonElement>(null);

  const settingsButton = (
    <div className="widget-swap-settings-wrap">
      <button
        ref={settingsBtnRef}
        type="button"
        className="widget-swap-settings-btn"
        onClick={() => setSettingsOpen((o) => !o)}
        aria-label="Swap settings"
        aria-expanded={settingsOpen}
        title="Swap settings"
      >
        <Settings className="widget-swap-settings-icon" strokeWidth={2} aria-hidden />
      </button>
      {settingsOpen && (
        <SwapSettingsPopover
          anchorRef={settingsBtnRef}
          slippagePct={slippagePct}
          onSlippageChange={handleSlippageChange}
          runFeeUsd={runFeeUsd}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );

  if (compact) {
    return (
      <div className="widget-hover widget-card widget-card--compact widget-card--glance widget-swap-card widget-swap-card--compact">
        <div className="widget-swap-compact-header">
          <p className="widget-card-eyebrow">Quick swap</p>
          {settingsButton}
        </div>
        <div className="widget-swap-compact-body">
          <div className="widget-swap-compact-row">
            <input
              type="text"
              inputMode="decimal"
              className="widget-swap-compact-amount"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Amount to swap"
            />
            <select
              className="widget-swap-compact-token"
              value={from}
              onChange={(e) => setFrom(e.target.value as string)}
              aria-label="Token to pay"
            >
              {pairs.map((t) => (
                <option key={t} value={t} disabled={t === to}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="widget-swap-compact-flip" onClick={flip} aria-label="Flip tokens">
            <ArrowDownUp className="widget-swap-flip-icon" strokeWidth={2} aria-hidden />
          </button>
          <div className="widget-swap-compact-row">
            <span className="widget-swap-compact-estimate" title="Est. after slippage and run fee">
              ≈ {formattedEstimate}
            </span>
            <select
              className="widget-swap-compact-token"
              value={to}
              onChange={(e) => setTo(e.target.value as string)}
              aria-label="Token to receive"
            >
              {pairs.map((t) => (
                <option key={t} value={t} disabled={t === from}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <input
            type="text"
            className="widget-swap-compact-wallet"
            placeholder="Destination wallet"
            value={destinationWallet}
            onChange={(e) => setDestinationWallet(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="Destination wallet address"
            aria-invalid={!walletValid}
          />
        </div>
        <button
          type="button"
          className="widget-swap-compact-submit"
          disabled={!canSubmit}
          onClick={() => void handlePayAndRun()}
        >
          {busy ? "Running…" : "Pay & run"}
        </button>
      </div>
    );
  }

  return (
    <div className="widget-hover widget-card widget-swap-card">
      <div className="widget-card-header widget-card-header--compact widget-swap-card-header">
        <div>
          <p className="widget-card-title">Quick swap</p>
        </div>
        {settingsButton}
      </div>
      <div className="widget-swap-body">
        <div className="widget-swap-stack">
          <div className="widget-swap-field">
            <span className="widget-swap-field-label">Pay</span>
            <div className="widget-swap-field-row">
              <input
                type="text"
                inputMode="decimal"
                className="widget-swap-amount"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-label="Amount to swap"
              />
              <select
                className="widget-swap-token"
                value={from}
                onChange={(e) => setFrom(e.target.value as string)}
                aria-label="Token to pay"
              >
                {pairs.map((t) => (
                  <option key={t} value={t} disabled={t === to}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="widget-swap-divider">
            <button type="button" className="widget-swap-flip-btn" onClick={flip} aria-label="Flip tokens">
              <ArrowDownUp className="widget-swap-flip-icon" strokeWidth={2} aria-hidden />
            </button>
          </div>

          <div className="widget-swap-field">
            <span className="widget-swap-field-label">Receive (est.)</span>
            <div className="widget-swap-field-row">
              <span className="widget-swap-estimate" title="Spot − slippage − run fee">
                {formattedEstimate}
              </span>
              <select
                className="widget-swap-token"
                value={to}
                onChange={(e) => setTo(e.target.value as string)}
                aria-label="Token to receive"
              >
                {pairs.map((t) => (
                  <option key={t} value={t} disabled={t === from}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <input
              type="text"
              className="widget-swap-wallet"
              placeholder="0x… destination wallet"
              value={destinationWallet}
              onChange={(e) => setDestinationWallet(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-label="Destination wallet address"
              aria-invalid={!walletValid}
            />
          </div>
        </div>
      </div>
      <button
        type="button"
        className="widget-swap-submit"
        disabled={!canSubmit}
        onClick={() => void handlePayAndRun()}
      >
        {busy ? "Processing…" : `Pay & run `}
      </button>
    </div>
  );
}
