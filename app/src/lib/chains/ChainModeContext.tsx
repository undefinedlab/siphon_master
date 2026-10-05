/**
 * Chain mode for the dapp — Mainnet (Solana → Arbitrum) vs Devnet (Solana → Sepolia).
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { CHAINS, type SiphonChain, isSolanaRuntime } from "@/lib/chains/registry";
import {
  connectPhantom,
  disconnectPhantom,
  restoreTrustedPhantom,
  subscribePhantom,
  type SolanaWalletSession,
} from "@/lib/chains/solanaWallet";
import { readStoredHomeChainId, resolveHomeChainOption } from "@/lib/chains/homeChains";

type ChainModeContextValue = {
  chain: SiphonChain;
  setChainId: (id: string) => void;
  solanaSession: SolanaWalletSession | null;
  connectSolana: () => Promise<SolanaWalletSession>;
  disconnectSolana: () => Promise<void>;
  isSolana: boolean;
};

const ChainModeContext = createContext<ChainModeContextValue | null>(null);

function defaultProductChain(): SiphonChain {
  const home = resolveHomeChainOption(readStoredHomeChainId());
  if (home?.productChainId && CHAINS[home.productChainId]) {
    return CHAINS[home.productChainId];
  }
  return (process.env.NEXT_PUBLIC_CLUSTER || "").toLowerCase() === "devnet"
    ? CHAINS["solana-devnet"]
    : CHAINS.base;
}

const DEFAULT_CHAIN = defaultProductChain();
const SOLANA_SESSION_KEY = "siphon:solana-session";
let currentProductChain = DEFAULT_CHAIN;

/** Current product chain for non-React execution helpers. */
export function getProductChain(): SiphonChain {
  return currentProductChain;
}

export function ChainModeProvider({ children }: { children: ReactNode }) {
  const [chainId, setChainId] = useState<string>(DEFAULT_CHAIN.id);
  const [solanaSession, setSolanaSession] = useState<SolanaWalletSession | null>(null);

  const chain = CHAINS[chainId] ?? DEFAULT_CHAIN;
  currentProductChain = chain;

  // Client hydrate: honor a previously chosen home chain, and again whenever the picker writes one.
  // Solana is reached through the home-chain picker or the Devnet toggle; there is no separate
  // /solana route any more. Without the event, a Solana Devnet pick made after mount left the
  // dashboard on the default EVM vault (Base) until the user clicked Devnet.
  useEffect(() => {
    const applyHome = () => {
      const home = resolveHomeChainOption(readStoredHomeChainId());
      if (home?.productChainId && CHAINS[home.productChainId]) {
        setChainId(home.productChainId);
      }
    };
    applyHome();
    window.addEventListener("siphon:homeChainChanged", applyHome);
    return () => window.removeEventListener("siphon:homeChainChanged", applyHome);
  }, []);

  const persistSession = useCallback((session: SolanaWalletSession | null) => {
    setSolanaSession(session);
    if (session) {
      localStorage.setItem(
        SOLANA_SESSION_KEY,
        JSON.stringify({ address: session.address, cluster: session.cluster }),
      );
    } else {
      localStorage.removeItem(SOLANA_SESSION_KEY);
    }
  }, []);

  const connectSolana = useCallback(async () => {
    const session = await connectPhantom();
    persistSession(session);
    // Connecting a wallet never picks the product chain. Callers that want Devnet (the Devnet
    // toggle, a native Solana home) set it themselves first; on a mainnet home Phantom is only the
    // funding / receiving wallet beside the EVM one. Deciding here from session.chainNumericId was
    // wrong on prod: solanaVaultChain() defaults to devnet when NEXT_PUBLIC_CLUSTER is unset, so
    // connecting Phantom on the mainnet Solana home flipped the whole dashboard into Devnet.
    return session;
  }, [persistSession]);

  const disconnectSolana = useCallback(async () => {
    await disconnectPhantom();
    persistSession(null);
  }, [persistSession]);

  useEffect(() => {
    let active = true;
    void restoreTrustedPhantom().then((session) => {
      if (!active || !session) return;
      persistSession(session);
    });
    const unsubscribe = subscribePhantom(
      (address) => {
        if (!address) {
          persistSession(null);
          return;
        }
        void restoreTrustedPhantom().then((session) => {
          if (active) persistSession(session);
        });
      },
      () => persistSession(null),
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [persistSession]);

  const value = useMemo(
    () => ({
      chain,
      setChainId,
      solanaSession,
      connectSolana,
      disconnectSolana,
      isSolana: isSolanaRuntime(chain),
    }),
    [chain, solanaSession, connectSolana, disconnectSolana],
  );

  return <ChainModeContext.Provider value={value}>{children}</ChainModeContext.Provider>;
}

export function useChainMode(): ChainModeContextValue {
  const ctx = useContext(ChainModeContext);
  if (!ctx) {
    throw new Error("useChainMode must be used within ChainModeProvider");
  }
  return ctx;
}

/** Product-facing alias used by deposit, swap, and strategy UX. */
export function useProductChain(): ChainModeContextValue {
  return useChainMode();
}
