"use client";

import { useMemo, useState } from "react";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { useProductChain } from "@/lib/chains/ChainModeContext";
import { getSolanaConnection } from "@/lib/chains/solanaWallet";
import { showAppToast } from "@/lib/appToast";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC =
  process.env.NEXT_PUBLIC_SOLANA_USDC_MINT ??
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function executorBase(): string {
  return (process.env.NEXT_PUBLIC_EXECUTOR_URL || process.env.NEXT_PUBLIC_API_URL || "").replace(
    /\/$/,
    "",
  );
}

type PhantomSigner = {
  signTransaction: (tx: Transaction | VersionedTransaction) => Promise<Transaction | VersionedTransaction>;
};

function getPhantomSigner(): PhantomSigner | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    solana?: PhantomSigner & { isPhantom?: boolean };
    phantom?: { solana?: PhantomSigner };
  };
  return w.solana?.isPhantom ? w.solana : w.phantom?.solana ?? null;
}

function encodeTx(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s);
}

/**
 * Public Jupiter bootstrap for SOL/USDC limit orders + devnet faucet.
 * Not a private vault spend — until siphon-vault CPI is live.
 */
export default function SolanaJupiterLimitPanel() {
  const { chain, isSolana, solanaSession, connectSolana } = useProductChain();
  const [side, setSide] = useState<"LIMIT_SELL" | "LIMIT_BUY">("LIMIT_SELL");
  const [amountUi, setAmountUi] = useState("0.1");
  const [triggerUsd, setTriggerUsd] = useState("200");
  const [busy, setBusy] = useState(false);
  const [lastOrder, setLastOrder] = useState("");

  const base = useMemo(() => executorBase(), []);
  if (!isSolana) return null;

  const requireOwner = async (): Promise<string> => {
    if (solanaSession?.address) return solanaSession.address;
    await connectSolana();
    // Session updates async; Phantom publicKey is available immediately after connect.
    const pk = (window as unknown as { solana?: { publicKey?: { toBase58(): string } } }).solana
      ?.publicKey?.toBase58();
    if (!pk) throw new Error("Connect Phantom first");
    return pk;
  };

  const amountBaseUnits = () => {
    const n = Number(amountUi);
    if (!Number.isFinite(n) || n <= 0) throw new Error("Enter a positive amount");
    return side === "LIMIT_SELL" ? Math.round(n * 1e9) : Math.round(n * 1e6);
  };

  const faucet = async () => {
    setBusy(true);
    try {
      const owner = await requireOwner();
      if (!base) throw new Error("Set NEXT_PUBLIC_EXECUTOR_URL to the trade-executor");
      const res = await fetch(`${base}/solana/faucet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey: owner, lamports: 1_000_000_000 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Faucet failed");
      showAppToast(`Airdropped 1 SOL (${String(body.signature).slice(0, 8)}…)`, "success");
    } catch (e) {
      showAppToast(e instanceof Error ? e.message : "Faucet failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const placeLimit = async () => {
    setBusy(true);
    try {
      if (!base) throw new Error("Set NEXT_PUBLIC_EXECUTOR_URL to the trade-executor");
      const owner = await requireOwner();
      const amount = amountBaseUnits();
      const trigger = Number(triggerUsd);
      if (!Number.isFinite(trigger) || trigger <= 0) throw new Error("Invalid trigger USD price");

      const craftRes = await fetch(`${base}/solana/jupiter/limit/craft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_pubkey: owner,
          amount,
          side,
          trigger_price_usd: trigger,
        }),
      });
      const craftBody = await craftRes.json().catch(() => ({}));
      if (!craftRes.ok) throw new Error(craftBody.error || "Jupiter craft failed");

      const craft = craftBody.craft || {};
      const txBase64: string =
        craft.transaction || craft.tx || craft.swapTransaction || craft.serializedTransaction || "";
      const requestId: string = craft.requestId || craft.depositRequestId || "";
      if (!txBase64 || !requestId) {
        throw new Error(
          "Jupiter craft missing transaction/requestId — set JUPITER_API_KEY on the executor (mainnet Trigger API)",
        );
      }

      const phantom = getPhantomSigner();
      if (!phantom?.signTransaction) throw new Error("Phantom signTransaction unavailable");

      const raw = Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0));
      let signedB64: string;
      try {
        const vtx = VersionedTransaction.deserialize(raw);
        const signed = (await phantom.signTransaction(vtx)) as VersionedTransaction;
        signedB64 = encodeTx(signed.serialize());
      } catch {
        const tx = Transaction.from(raw);
        const signed = (await phantom.signTransaction(tx)) as Transaction;
        signedB64 = encodeTx(signed.serialize());
      }

      try {
        const conn = getSolanaConnection();
        await conn.sendRawTransaction(Uint8Array.from(atob(signedB64), (c) => c.charCodeAt(0)));
      } catch {
        // Trigger submit may broadcast depositSignedTx
      }

      const submitRes = await fetch(`${base}/solana/jupiter/limit/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_pubkey: owner,
          amount,
          side,
          trigger_price_usd: trigger,
          deposit_request_id: requestId,
          deposit_signed_tx: signedB64,
        }),
      });
      const submitBody = await submitRes.json().catch(() => ({}));
      if (!submitRes.ok) throw new Error(submitBody.error || "Jupiter submit failed");
      const orderId = String(submitBody.order?.id || submitBody.order?.orderId || "submitted");
      setLastOrder(orderId);
      showAppToast(`Jupiter SOL/USDC limit placed (${orderId})`, "success");
    } catch (e) {
      showAppToast(e instanceof Error ? e.message : "Limit order failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="userdash-view loaded" data-runtime="solana-v1-jupiter-bootstrap">
      <div className="userdash-content-wrapper">
        <div className="userdash-header">
          <h1 className="userdash-title">Jupiter SOL/USDC Limit</h1>
        </div>
        <div className="userdash-transaction-card">
          <p className="userdash-notes-description">
            Public Jupiter Trigger on {chain.label}. Use <strong>Faucet</strong> on Solana Devnet for
            test SOL. Live limit orders need mainnet funds + executor <code>JUPITER_API_KEY</code>.
            This is not a private vault spend.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 420 }}>
            <label>
              Side
              <select
                value={side}
                onChange={(e) => setSide(e.target.value as "LIMIT_SELL" | "LIMIT_BUY")}
                className="node-select"
              >
                <option value="LIMIT_SELL">Sell SOL → USDC (above)</option>
                <option value="LIMIT_BUY">Buy SOL ← USDC (below)</option>
              </select>
            </label>
            <label>
              Amount ({side === "LIMIT_SELL" ? "SOL" : "USDC"})
              <input
                className="node-input"
                value={amountUi}
                onChange={(e) => setAmountUi(e.target.value)}
              />
            </label>
            <label>
              Trigger USD (SOL)
              <input
                className="node-input"
                value={triggerUsd}
                onChange={(e) => setTriggerUsd(e.target.value)}
              />
            </label>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button type="button" className="top-connect-button" disabled={busy} onClick={() => void faucet()}>
                Faucet 1 SOL
              </button>
              <button
                type="button"
                className="top-connect-button"
                disabled={busy}
                onClick={() => void placeLimit()}
              >
                Place Jupiter limit
              </button>
            </div>
            <p style={{ fontSize: "0.75rem", opacity: 0.7 }}>
              SOL {WSOL.slice(0, 6)}… · USDC {USDC.slice(0, 6)}…
              {lastOrder ? ` · order ${lastOrder}` : ""}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
