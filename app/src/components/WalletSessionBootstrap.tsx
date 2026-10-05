"use client";

import { useEffect } from "react";
import { walletManager } from "@/components/extensions/walletManager";
import { getSigner } from "@/lib/nexus";
import { initializeWithProvider } from "@/lib/nexus";
import { clearSession } from "@/lib/sessionKey";
import { hasCompletedOnboarding } from "@/lib/onboarding";
import { primeSessionKey } from "@/lib/walletAuthHeaders";
import { readStoredHomeChainId, resolveHomeChainOption } from "@/lib/chains/homeChains";
import { getSelectedChainId } from "@/lib/networks";

/**
 * Restores non-EVM wallet sessions (Phantom, etc.) after reload and keeps UI + signer in sync.
 * EVM restore is handled by wagmi's own reconnectOnMount + EvmWalletBridge's onConnect callback;
 * the 'evm' branch below is a harmless no-op fallback (restorePersistedSession() never resolves
 * 'evm' synchronously — it only returns whatever EvmWalletBridge has already adopted this session).
 *
 * Also primes the session key on connect. Doing it HERE rather than lazily inside the first
 * authenticated request is the point: minting a session is itself a wallet prompt, and firing it
 * mid-request would trade several predictable popups for one that appears at a surprising moment.
 * At connect time the user is already engaged with their wallet, so it reads as part of connecting.
 *
 * A decline is not an error — every auth path falls back to signing with the wallet, which is
 * exactly the behaviour before session keys existed.
 */
export default function WalletSessionBootstrap() {
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const wallet = await walletManager.restorePersistedSession();
      if (cancelled) return;

      const evmProvider = walletManager.getEvmProvider();
      if (wallet?.id === "evm" && evmProvider) {
        try {
          await initializeWithProvider(evmProvider);
        } catch (error) {
          console.error("Failed to restore ethers session:", error);
          walletManager.clearSession();
          window.dispatchEvent(new Event("walletDisconnected"));
          return;
        }
      }

      if (wallet) {
        window.dispatchEvent(new Event("walletConnected"));
      }
    })();

    // Prime on any connect, including ones this component did not perform (EvmWalletBridge).
    // Returns whether a signer was there to prime with, so the poll below knows when to stop.
    let primed = false;
    const onConnected = (): boolean => {
      if (primed) return true;

      // Not until onboarding is done. This mounts from the root providers, so it runs on the
      // landing page AND behind the welcome guide — which lives AT /dapp, not on a route of its
      // own, so a pathname check does not see it (that was the first attempt at this gate, and it
      // let the popup through). hasCompletedOnboarding is the flag the guide itself sets.
      //
      // Reading a "risks of early alpha software" guide is not consent to sign. Returning false
      // rather than true keeps the poll alive, so priming happens the moment the guide is dismissed
      // with a wallet already connected.
      if (!hasCompletedOnboarding()) return false;

      // Not until they have picked a home chain. A clean load used to sign the moment MetaMask
      // auto-reconnected, on Base (the 8453 fallback), before the picker — including when the
      // network they were about to choose was Solana Devnet.
      const home = resolveHomeChainOption(readStoredHomeChainId());
      if (!home) return false;
      // Solana Devnet signs with Phantom after that home is active, not with the EVM wallet.
      if (home.kind === "solana" || home.productChainId === "solana-devnet") return true;

      const signer = getSigner();
      if (!signer) return false;
      // Exactly one attempt per page load, decline included. ensureSession clears its in-flight
      // entry on rejection, so a poll that kept retrying would reopen the prompt every tick —
      // the same shape as the 260-popups-in-3h bug the signature gate exists to prevent.
      primed = true;
      void (async () => {
        try {
          const chainId = home.numericId ?? getSelectedChainId();
          await primeSessionKey(signer, chainId);
        } catch {
          /* declined or unavailable — auth falls back to wallet signing */
        }
      })();
      return true;
    };

    // A reload with an already-connected wallet is the common case, and MetaMask's auto-reconnect
    // can land after mount without firing walletConnected (TeeClientKeySync polls for the same
    // reason). Without this, every reload silently skips priming and the popups come back — which
    // reads as "session keys don't work" rather than "the event didn't fire".
    let poll: ReturnType<typeof setInterval> | null = null;
    const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };
    if (!onConnected()) {
      poll = setInterval(() => { if (onConnected()) stopPoll(); }, 2000);
      // Long enough to outlast reading the onboarding guide: the poll is now also what carries a
      // connected wallet from the landing page onto /dapp, and 60s of reading would have expired
      // it — leaving that session unprimed and the popups back, only intermittently.
      setTimeout(stopPoll, 10 * 60_000);
    }
    // Disconnect must drop the session key: leaving it behind would let the previous account's
    // delegation sit in storage across an account switch.
    const onDisconnected = () => {
      primed = false;
      clearSession();
    };

    window.addEventListener("walletConnected", onConnected);
    window.addEventListener("walletDisconnected", onDisconnected);

    return () => {
      cancelled = true;
      stopPoll();
      window.removeEventListener("walletConnected", onConnected);
      window.removeEventListener("walletDisconnected", onDisconnected);
    };
  }, []);

  return null;
}
