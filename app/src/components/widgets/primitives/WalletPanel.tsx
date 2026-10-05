"use client";

import { useEffect, useState } from "react";
import ConnectButton from "@/components/extensions/ConnectButton";
import { walletManager, type WalletInfo } from "@/components/extensions/walletManager";
import type { SizePreset } from "@/components/widgets/config/grid";
import { SIZE_TO_GRID } from "@/components/widgets/config/grid";
import { useVaultBalance } from "@/lib/vaultBalanceStore";

const VAULT_TOKENS = ["ETH", "USDC"] as const;

function formatVaultAmount(symbol: (typeof VAULT_TOKENS)[number], amount: number): string {
  return symbol === "USDC" ? amount.toFixed(2) : amount.toFixed(4);
}

function isWideWalletSize(size: SizePreset): boolean {
  const { col, row } = SIZE_TO_GRID[size];
  return row === 1 && col >= 2;
}

export function WalletPanel({
  sectionId,
  size = "2x1",
}: {
  sectionId?: string;
  size?: SizePreset;
}) {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const vault = useVaultBalance();
  const wide = isWideWalletSize(size);

  useEffect(() => {
    const sync = async () => {
      const restored = await walletManager.restorePersistedSession();
      setWallet(restored ?? walletManager.getConnectedWallets()[0] ?? null);
    };
    const onWalletEvent = () => { void sync(); };
    void sync();
    window.addEventListener("walletConnected", onWalletEvent);
    window.addEventListener("walletDisconnected", onWalletEvent);
    return () => {
      window.removeEventListener("walletConnected", onWalletEvent);
      window.removeEventListener("walletDisconnected", onWalletEvent);
    };
  }, []);

  const openDashboard = () => {
    window.dispatchEvent(new CustomEvent("userdash-view-change", { detail: "userdash" }));
    window.dispatchEvent(new CustomEvent("pro-view-mode-change", { detail: "userdash" }));
  };

  const vaultBalances = wallet?.id === "evm" ? vault.display : null;

  return (
    <div
      {...(sectionId ? { id: sectionId } : {})}
      className={`widget-hover widget-card${wide ? " widget-card--wallet-wide" : ""}`}
    >
      <div className="widget-card-header widget-card-header--compact">
        <div>
          <p className="widget-card-title">Wallet</p>
          <p className="widget-card-subtitle">Private balance</p>
        </div>
      </div>
      <div className={`widget-wallet-body${wide ? " widget-wallet-body--wide" : ""}`}>
        {wallet ? (
          <>
            <div className="widget-wallet-balance-block">
              <p className="widget-stat-label">Vault</p>
              <ul className="widget-wallet-vault-list">
                {VAULT_TOKENS.map((sym) => (
                  <li key={sym} className="widget-wallet-vault-row">
                    <span className="widget-wallet-vault-symbol">{sym}</span>
                    <span className="widget-wallet-vault-amount">
                      {vaultBalances
                        ? formatVaultAmount(sym, vaultBalances[sym] ?? 0)
                        : "…"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="widget-wallet-address">
                {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
              </p>
            </div>
            <button type="button" className="widget-wallet-action" onClick={openDashboard}>
              Open dashboard
            </button>
          </>
        ) : (
          <div className="widget-wallet-connect">
            <p className="widget-card-subtitle">Connect to view vault funds</p>
            <ConnectButton className="widget-wallet-connect-btn" />
          </div>
        )}
      </div>
    </div>
  );
}
