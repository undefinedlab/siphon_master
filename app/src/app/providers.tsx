"use client";

import "@rainbow-me/rainbowkit/styles.css";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import BotDeterrent from "@/components/BotDeterrent";
import AppToastHost from "@/components/theme/AppToastHost";
import WalletSessionBootstrap from "@/components/WalletSessionBootstrap";
import BackupRetryDrainer from "@/components/BackupRetryDrainer";
import EvmWalletBridge from "@/components/EvmWalletBridge";
import { wagmiConfig, siphonRainbowKitTheme } from "@/lib/wagmiConfig";
import { ChainModeProvider } from "@/lib/chains/ChainModeContext";

export function AppProviders({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [queryClient] = useState(() => new QueryClient());

  // Wallet connector libraries touch client-only state while rendering. Keeping the first server
  // and browser render identical prevents Next's static prerender from executing those hooks before
  // their providers exist, then mounts the dapp immediately after hydration.
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div aria-label="Loading Siphon" className="min-h-screen bg-black" />;
  }

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={siphonRainbowKitTheme}>
          <ChainModeProvider>
            <BotDeterrent />
            <EvmWalletBridge />
            <WalletSessionBootstrap />
            <BackupRetryDrainer />
            {children}
            <AppToastHost />
          </ChainModeProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
