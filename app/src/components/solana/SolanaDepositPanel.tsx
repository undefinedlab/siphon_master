"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useProductChain } from "@/lib/chains/ChainModeContext";
import {
  DEVNET_VAULT_CHAIN_ID,
  isDevnetProduct,
} from "@/lib/chains/productGates";
import {
  ARBITRUM_VAULT_CHAIN_ID,
  planSolUsdcToEvm,
  usdcToBaseUnits,
} from "@/lib/chains/mainnetSolBridge";
import { bridgeUsdcDevnetToSepolia, usdcToBaseUnitsDevnet } from "@/lib/chains/devnetSolBridge";
import { showAppToast } from "@/lib/appToast";
import { selectChainAndSwitchWallet } from "@/lib/networks";

const MAINNET_SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type FundPlan = {
  ok?: boolean;
  pending?: boolean;
  message?: string;
  steps?: string[];
  stepStatus?: Array<{
    step: string;
    status: string;
    message?: string;
    quoteAvailable?: boolean;
    toolUrl?: string;
  }>;
  clientNext?: string;
};

/**
 * Solana front door: USDC-only public hop into Arbitrum (mainnet) or Sepolia test USDC (devnet).
 */
export default function SolanaDepositPanel() {
  const { chain, solanaSession, connectSolana, setChainId: setProductChainId } = useProductChain();
  const { address: evmAddress, isConnected: evmConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<FundPlan | null>(null);

  const recipient = useMemo(() => evmAddress ?? "", [evmAddress]);
  const isDevnet = isDevnetProduct(chain);
  const destChainId = isDevnet ? DEVNET_VAULT_CHAIN_ID : ARBITRUM_VAULT_CHAIN_ID;
  const solanaUsdcMint = isDevnet
    ? process.env.NEXT_PUBLIC_SOLANA_USDC_MINT?.trim() || MAINNET_SOLANA_USDC
    : MAINNET_SOLANA_USDC;
  const destLabel = isDevnet ? "Sepolia" : "Arbitrum";

  const submit = async () => {
    let baseAmount: bigint;
    try {
      baseAmount = isDevnet ? usdcToBaseUnitsDevnet(amount) : usdcToBaseUnits(amount);
    } catch (error) {
      showAppToast(error instanceof Error ? error.message : "Invalid amount.", "error");
      return;
    }
    if (baseAmount <= 0n) {
      showAppToast("Enter a valid USDC amount to bridge.", "error");
      return;
    }
    if (!solanaSession) {
      try {
        await connectSolana();
      } catch (error) {
        showAppToast(error instanceof Error ? error.message : "Could not connect Phantom.", "error");
      }
      return;
    }
    if (!evmConnected || !recipient) {
      openConnectModal?.();
      showAppToast(`Connect an EVM wallet — vault custody lives on ${destLabel}.`, "info");
      return;
    }

    setBusy(true);
    setPlan(null);
    try {
      if (isDevnet) {
        setProductChainId("solana-devnet");
        const custody = DEVNET_VAULT_CHAIN_ID;
        showAppToast("Switching wallet to Sepolia for Devnet USDC…", "info");
        await selectChainAndSwitchWallet(custody, recipient);
        showAppToast(
          "Crediting Sepolia USDC (does not debit Phantom)…",
          "info",
        );
        const result = await bridgeUsdcDevnetToSepolia({
          amountBaseUnits: baseAmount,
          solanaOwner: solanaSession.address,
          recipient,
        });
        setPlan({
          ok: true,
          message: result.message,
          clientNext: "Deposit USDC below with depositV3 on Sepolia.",
          stepStatus: [
            {
              step: "test_bridge_mint_usdc",
              status: "completed",
              message: result.mintTx ? `mint ${result.mintTx.slice(0, 10)}…` : "minted",
            },
          ],
        });
        showAppToast(
          result.message || "Test USDC minted — deposit USDC into the Sepolia vault below.",
          "success",
        );
        return;
      }

      setProductChainId("solana-mainnet");
      showAppToast("Quoting Li.Fi Solana USDC → Arbitrum…", "info");
      const body = await planSolUsdcToEvm({
        amountBaseUnits: baseAmount,
        solanaOwner: solanaSession.address,
        recipient,
        toChainId: ARBITRUM_VAULT_CHAIN_ID,
      });
      setPlan(body);
      const bridge = body.stepStatus?.find((s) => s.step === "public_bridge_hop");
      showAppToast(
        body.message ||
          "Bridge plan ready. Complete the Phantom hop, then deposit USDC on Arbitrum.",
        bridge?.quoteAvailable ? "success" : "info",
      );
      if (bridge?.toolUrl && typeof window !== "undefined") {
        window.open(bridge.toolUrl, "_blank", "noopener,noreferrer");
      }
      await selectChainAndSwitchWallet(ARBITRUM_VAULT_CHAIN_ID, recipient);
    } catch (error) {
      showAppToast(error instanceof Error ? error.message : "Fund plan failed.", "error");
    } finally {
      setBusy(false);
    }
  };

  const cta = !solanaSession
    ? "Connect Phantom"
    : !evmConnected
      ? "Connect EVM wallet"
      : busy
        ? "Planning…"
        : isDevnet
          ? "Credit USDC → Sepolia"
          : `Plan USDC → ${destLabel}`;

  return (
    <section
      className="userdash-transaction-card"
      data-runtime="solana-wrapper"
      data-custody-chain={isDevnet ? DEVNET_VAULT_CHAIN_ID : destChainId}
      data-testid="solana-fund-usdc-panel"
      style={{ marginBottom: "1rem" }}
    >
      <div className="userdash-balance-header">
        <h2 className="userdash-balance-title">Fund from Solana (USDC)</h2>
        <span className="userdash-balance-network">
          {chain.label} → {destLabel}
        </span>
      </div>
      <p className="userdash-notes-description">
        USDC only. Bridge publicly into your EVM wallet, then deposit into the Siphon vault
        {isDevnet
          ? " on Sepolia. Devnet credits USDC 1:1 (faucet) and does not take Phantom funds."
          : " on Arbitrum."}
      </p>
      <div className="userdash-input-group">
        <input
          className="userdash-input"
          inputMode="decimal"
          placeholder="USDC amount"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          data-testid="solana-fund-amount"
        />
        <select className="userdash-select" value="USDC" disabled>
          <option value="USDC">USDC</option>
        </select>
      </div>
      {recipient ? (
        <p className="userdash-notes-description" title={recipient}>
          {destLabel} recipient: {recipient.slice(0, 6)}…{recipient.slice(-4)}
        </p>
      ) : null}
      <p className="userdash-notes-description" title={solanaUsdcMint}>
        Solana mint: {solanaUsdcMint.slice(0, 4)}…{solanaUsdcMint.slice(-4)}
      </p>
      <button
        className="userdash-confirm-button"
        disabled={busy}
        onClick={() => void submit()}
        data-testid="solana-fund-submit"
      >
        {cta}
      </button>
      {plan ? (
        <div className="userdash-notes-description" data-testid="solana-fund-plan">
          <p>{plan.message}</p>
          <ol>
            {(plan.stepStatus || []).map((step) => (
              <li key={step.step}>
                <strong>{step.step}</strong> [{step.status}] {step.message}
                {step.toolUrl ? (
                  <>
                    {" "}
                    <a href={step.toolUrl} target="_blank" rel="noreferrer">
                      open bridge
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ol>
          {plan.clientNext ? <p>{plan.clientNext}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
