"use client";

import { usePathname } from "next/navigation";
import ConnectButton from "./ConnectButton";
import { WalletInfo } from "./walletManager";

interface DAppNavProps {
  onWalletConnected?: (wallet: WalletInfo) => void;
}

export default function DAppNav({ onWalletConnected }: DAppNavProps) {
  usePathname(); // Keep for potential future use

  return (
    <>
      {/* Wallet Connector */}
      <div className="top-right-wallet-connector">
        <ConnectButton 
          className="top-connect-button"
          onConnected={onWalletConnected}
        />
      </div>
    </>
  );
}

