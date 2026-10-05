"use client";

/**
 * Vault-hub controls for the Deposit / Withdraw card:
 *   ReceiveOnFields — withdraw from a Siphon vault to another chain (executor + LI.FI);
 *   FundFromChain   — bridge USDC into the user's vault-chain wallet, then the normal deposit.
 */
import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { displayAmount } from "@/lib/amountString";
import { getReadProvider } from "@/lib/zkHandler";
import { connectPhantom } from "@/lib/chains/solanaWallet";
import {
  bridgeMinUnits,
  ZCASH_LIFI_ID,
  bridgeDest,
  bridgeDestOptionLabel,
  bridgeDestsFrom,
  bridgeQuote,
  bridgeStatusText,
  fundSourceForEdge,
  fundSourcesInto,
  isValidDestAddress,
  lifiScanUrl,
  bridgeDestDisclaimer,
  vaultLabel,
  vaultUsdc,
  type BridgeOrder,
} from "@/lib/bridge/hub";
import {
  BASE_NATIVE,
  GAS_HOP_WEI,
  MIN_BASE_GAS_WEI,
  lifiFundQuote,
  sendLifiQuote,
  waitLifiDone,
  type LifiQuote,
} from "@/lib/bridge/fund";

const fmt = (units: string, decimals: number) => displayAmount(ethers.formatUnits(units, decimals));
const eta = (sec?: number) => (sec ? `~${Math.max(1, Math.round(sec / 60))} min` : null);

function usdcUnits(amount: string): bigint {
  try {
    return ethers.parseUnits((amount || "0").trim(), 6);
  } catch {
    return 0n;
  }
}

function TrackLink({ tx }: { tx: string }) {
  return (
    <>
      {" · "}
      <a href={lifiScanUrl(tx)} target="_blank" rel="noopener noreferrer" className="userdash-link-button">
        Track
      </a>
    </>
  );
}

export function ReceiveOnFields(p: {
  vaultLabel: string;
  /** Vault chain the note lives on (Base or Arbitrum). */
  vaultChainId: number;
  receiveOn: number | null;
  onReceiveOn: (id: number | null) => void;
  amount: string;
  recipient: string;
  refundAddress: string;
  order: BridgeOrder | null;
}) {
  const dests = bridgeDestsFrom(p.vaultChainId);
  const dest = bridgeDest(p.receiveOn);
  const [line, setLine] = useState<string | null>(null);

  // Live price for the line under the selector. Display only — Confirm re-quotes right before
  // proving, since the proof alone takes tens of seconds.
  useEffect(() => {
    if (!dest || dest.id === p.vaultChainId) return setLine(null);
    const units = usdcUnits(p.amount);
    const min = bridgeMinUnits(dest);
    if (units < min) return setLine(`Sending to ${dest.label} needs at least ${Number(min) / 1e6} USDC.`);
    if (!isValidDestAddress(dest.kind, p.recipient)) return setLine(`Enter your ${dest.label} address.`);
    let live = true;
    setLine("Quoting…");
    const t = window.setTimeout(() => {
      bridgeQuote(
        {
          to_chain_id: dest.id,
          to_address: p.recipient.trim(),
          to_token: dest.toToken,
          amount: units.toString(),
          min_out: "1",
          refund_address: p.refundAddress,
        },
        p.vaultChainId,
      )
        .then((q) => {
          if (!live) return;
          // Small sends on some routes lose a big share to fixed fees (1 USDC to Ethereum: ~41%).
          const pct = (Number(q.feeUsd) / Number(p.amount)) * 100;
          setLine(
            `Receive ≈ ${fmt(q.toAmount, q.toToken.decimals)} ${q.toToken.symbol} via ${q.tool} · ` +
              `${eta(q.durationSec) ?? dest.eta} · fees ≈ $${q.feeUsd}` +
              (pct >= 10 ? ` — that is ${Math.round(pct)}% of this send; a larger amount costs proportionally less` : ""),
          );
        })
        .catch((e: unknown) => live && setLine(e instanceof Error ? e.message : "No route right now."));
    }, 600);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [dest, p.amount, p.recipient, p.refundAddress, p.vaultChainId]);

  return (
    <>
      <div className="userdash-input-group">
        <select
          className="userdash-select userdash-select--grow"
          value={p.receiveOn ?? ""}
          onChange={(e) => p.onReceiveOn(e.target.value ? Number(e.target.value) : null)}
          aria-label="Receive on"
        >
          <option value="">Receive on {p.vaultLabel}</option>
          {dests.map((d) => (
            <option key={d.id} value={d.id}>
              Receive on {bridgeDestOptionLabel(d)}
            </option>
          ))}
        </select>
      </div>
      {dest && bridgeDestDisclaimer(dest) && (
        <div className="userdash-fee-quoting">{bridgeDestDisclaimer(dest)}</div>
      )}
      {line && <div className="userdash-fee-quoting">{line}</div>}
      {p.order && (
        <div className="userdash-fee-quoting">
          Bridge: {bridgeStatusText(p.order)}
          {p.order.bridge_tx && <TrackLink tx={p.order.bridge_tx} />}
        </div>
      )}
    </>
  );
}

/**
 * What a funding route delivers, step by step, ending at the vault. The vault takes no cut
 * on deposit (VaultKernel.deposit credits exactly what it pulls), so what LI.FI lands is
 * what the private balance gains; the bridge fees are already out of that number.
 */
function FundBreakdown(p: { q: LifiQuote; sent: string; from: string; vault: string }) {
  const { q } = p;
  const fee = (q.estimate.feeCosts ?? []).reduce((s, f) => s + Number(f.amountUSD || 0), 0);
  const time = eta(q.estimate.executionDuration);
  return (
    <div className="userdash-fee-quoting">
      You send {displayAmount(p.sent)} USDC from {p.from}
      <br />
      Arrives on {p.vault} ≈ {fmt(q.estimate.toAmount, 6)} USDC (at least {fmt(q.estimate.toAmountMin, 6)}) via{" "}
      {q.toolDetails?.name || q.tool}
      {time ? ` · ${time}` : ""}
      <br />
      <strong>Into your private vault ≈ {fmt(q.estimate.toAmount, 6)} USDC</strong> — the deposit takes no cut
      <br />
      Bridge fees ≈ ${fee.toFixed(2)}, already taken out · you pay network gas on {p.from} and on {p.vault}
    </div>
  );
}

export function FundFromChain(p: {
  /** Hidden unless a bridge vault is selected — but stays mounted mid-flow across chain switches. */
  onHub: boolean;
  vaultChainId: number;
  evmAddress: string;
  solanaAddress: string | null;
  edge: number | null;
  onArrived: (amountHuman: string) => void;
}) {
  const sources = useMemo(() => fundSourcesInto(p.vaultChainId), [p.vaultChainId]);
  const vaultName = vaultLabel(p.vaultChainId);
  const toUsdc = vaultUsdc(p.vaultChainId);
  const [open, setOpen] = useState(false);
  const [srcId, setSrcId] = useState(() => {
    const edge = fundSourceForEdge(p.edge);
    return sources.some((s) => s.id === edge) ? edge : (sources[0]?.id ?? 1);
  });
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<LifiQuote | string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [track, setTrack] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gasLow, setGasLow] = useState(false);
  const src = sources.find((s) => s.id === srcId) ?? sources[0];
  const fromAddress = src?.kind === "solana" ? p.solanaAddress : p.evmAddress;

  useEffect(() => {
    const edge = fundSourceForEdge(p.edge);
    const next = sources.some((s) => s.id === edge) ? edge : (sources[0]?.id ?? 1);
    setSrcId(next);
  }, [p.edge, sources]);

  useEffect(() => {
    if (!open || !p.evmAddress) return;
    getReadProvider(p.vaultChainId)
      .getBalance(p.evmAddress)
      .then((b) => setGasLow(b < MIN_BASE_GAS_WEI))
      .catch(() => undefined);
  }, [open, p.evmAddress, p.vaultChainId, busy]);

  useEffect(() => {
    const units = usdcUnits(amount);
    if (!open || units <= 0n || !fromAddress || !src) return setPreview(null);
    let live = true;
    const t = window.setTimeout(() => {
      lifiFundQuote({
        src,
        fromToken: src.usdc,
        toToken: toUsdc,
        fromAddress,
        toAddress: p.evmAddress,
        fromAmount: units,
        toChain: p.vaultChainId,
      })
        .then((q) => live && setPreview(q))
        .catch((e: unknown) => live && setPreview(e instanceof Error ? e.message : "No route right now."));
    }, 600);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [open, amount, src, fromAddress, p.evmAddress, p.vaultChainId, toUsdc]);

  if (!p.onHub && !busy) return null;
  if (!src) return null;

  const run = async (gas: boolean) => {
    setBusy(true);
    setTrack(null);
    try {
      const from = src.kind === "solana" ? p.solanaAddress ?? (await connectPhantom()).address : p.evmAddress;
      setStatus("Finding a route…");
      const q = await lifiFundQuote(
        gas
          ? {
              src,
              fromToken: src.gasToken,
              toToken: BASE_NATIVE,
              fromAddress: from,
              toAddress: p.evmAddress,
              toAmount: GAS_HOP_WEI,
              toChain: p.vaultChainId,
            }
          : {
              src,
              fromToken: src.usdc,
              toToken: toUsdc,
              fromAddress: from,
              toAddress: p.evmAddress,
              fromAmount: usdcUnits(amount),
              toChain: p.vaultChainId,
            },
      );
      setStatus(`Confirm in ${src.kind === "solana" ? "Phantom" : "your wallet"}…`);
      const tx = await sendLifiQuote(q, src, p.vaultChainId);
      setTrack(tx);
      setStatus(`Bridging to ${vaultName}…`);
      const got = await waitLifiDone(tx, src.id, setStatus, p.vaultChainId);
      if (gas) {
        setStatus(`${fmt(got.amount, 18)} ETH arrived on ${vaultName} for gas.`);
      } else if (got.token.toLowerCase() === toUsdc.toLowerCase()) {
        const human = ethers.formatUnits(got.amount, 6);
        setStatus(`${displayAmount(human)} USDC arrived on ${vaultName}.`);
        setAmount("");
        p.onArrived(human);
      } else {
        setStatus(`Funds arrived on ${vaultName} as a different token — deposit them from your wallet.`);
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Bridge failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="userdash-fee-quoting">
        <button type="button" className="userdash-link-button" onClick={() => setOpen(true)}>
          Fund from another chain
        </button>
      </div>
    );
  }

  return (
    <div className="userdash-fee-panel">
      <div className="userdash-input-group">
        <select
          className="userdash-select userdash-select--fixed"
          value={srcId}
          onChange={(e) => setSrcId(Number(e.target.value))}
          disabled={busy}
          aria-label="Fund from"
        >
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          inputMode="decimal"
          placeholder="USDC amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="userdash-input"
          disabled={busy}
        />
      </div>
      {p.edge === ZCASH_LIFI_ID && (
        <div className="userdash-fee-quoting">
          Your home chain Zcash can&apos;t fund the vault — fund it from one of the chains above.
        </div>
      )}
      {p.edge === 1337 && (
        <div className="userdash-fee-quoting">Hyperliquid funds through HyperEVM — move USDC there first.</div>
      )}
      {typeof preview === "string" ? (
        <div className="userdash-fee-quoting">{preview}</div>
      ) : preview ? (
        <FundBreakdown q={preview} sent={amount} from={src.label} vault={vaultName} />
      ) : (
        <div className="userdash-fee-quoting">Enter an amount to see how much reaches your private vault.</div>
      )}
      {gasLow && (
        <div className="userdash-fee-warn">
          Your {vaultName} wallet has too little ETH to pay the deposit gas.{" "}
          <button type="button" className="userdash-link-button" disabled={busy} onClick={() => void run(true)}>
            Get {ethers.formatEther(GAS_HOP_WEI)} ETH on {vaultName} from {src.label}
          </button>
        </div>
      )}
      {status && (
        <div className="userdash-fee-quoting">
          {status}
          {track && <TrackLink tx={track} />}
        </div>
      )}
      <div className="userdash-fee-quoting">
        <button
          type="button"
          className="userdash-link-button"
          disabled={busy || usdcUnits(amount) <= 0n}
          onClick={() => void run(false)}
        >
          {busy ? "Bridging…" : `Bridge to ${vaultName}`}
        </button>
        {" · then Confirm deposits it privately"}
      </div>
    </div>
  );
}
