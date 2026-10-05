"use client";

/**
 * Bridges wagmi/RainbowKit's connector state into WalletManager. RainbowKit's modal negotiates
 * wallet approval (MetaMask, Coinbase Wallet, WalletConnect, any EIP-6963 injected wallet); once
 * wagmi reports a connected account, this hands its EIP-1193 provider to
 * walletManager.adoptEvmWallet(), which runs the existing network-switch + signer-init +
 * persistence sequence every other module (deposits, vault balance, FHE key sync) already expects.
 */

import { useCallback, useEffect, useRef } from "react";
import { useAccount, useAccountEffect, useDisconnect } from "wagmi";
import { walletManager, type EthereumLikeProvider } from "@/components/extensions/walletManager";
import { showAppToast } from "@/lib/appToast";

/** wagmi stuck mid-handshake (connecting/reconnecting) — fail open so the modal works again. */
const RECONNECT_WATCHDOG_MS = 5_000;
/** wagmi says connected but adopt never finished (missed onConnect race, hung provider, etc.). */
const ADOPT_STUCK_WATCHDOG_MS = 10_000;

type AdoptArgs = {
  address: `0x${string}`;
  addresses?: readonly `0x${string}`[];
  chainId: number;
  connector: { name: string; getProvider: () => Promise<unknown> };
  isReconnected: boolean;
};

export default function EvmWalletBridge() {
  const { disconnectAsync } = useDisconnect();
  const { address, addresses, chainId, connector, status } = useAccount();
  const adoptingRef = useRef(false);

  useEffect(() => {
    walletManager.registerEvmDisconnector(() => disconnectAsync());
    return () => walletManager.registerEvmDisconnector(null);
  }, [disconnectAsync]);

  const adoptConnectedWallet = useCallback(
    async ({ address: addr, addresses: addrs, chainId: cid, connector: conn, isReconnected }: AdoptArgs) => {
      if (walletManager.isWalletConnected("evm")) return;
      if (adoptingRef.current) return;
      adoptingRef.current = true;
      try {
        const provider = (await conn.getProvider()) as EthereumLikeProvider;
        const result = await walletManager.adoptEvmWallet(provider, {
          address: addr,
          name: conn.name,
          accounts: addrs ? [...addrs] : [addr],
          chainId: cid,
          isReconnect: isReconnected,
        });
        if (result.success) {
          window.dispatchEvent(new Event("walletConnected"));
          return;
        }
        const label = isReconnected ? "reconnected" : "connected";
        console.error(`Failed to adopt ${label} wallet:`, result.error);
        if (!isReconnected) {
          // Silent reconnect failure is background noise; a fresh user approval failing is not.
          showAppToast(`Wallet connect failed: ${result.error ?? "unknown error"}`, "error");
        }
        // wagmi believes isConnected=true (RainbowKit withholds openConnectModal) while
        // walletManager never adopted — disconnect so both sides agree and the button works.
        await disconnectAsync().catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Failed to adopt connected wallet:", error);
        if (!isReconnected) {
          showAppToast(`Wallet connect failed: ${message}`, "error");
        }
        await disconnectAsync().catch(() => undefined);
      } finally {
        adoptingRef.current = false;
      }
    },
    [disconnectAsync],
  );

  // Keep handlers stable so useAccountEffect does not tear down / re-subscribe watchAccount on
  // every render — that resubscribe is exactly how reconnect→connected transitions get missed.
  const adoptRef = useRef(adoptConnectedWallet);
  adoptRef.current = adoptConnectedWallet;

  const onConnect = useCallback((data: AdoptArgs) => {
    void adoptRef.current(data);
  }, []);

  const onDisconnect = useCallback(() => {
    walletManager.disconnectWallet("evm");
    window.dispatchEvent(new Event("walletDisconnected"));
  }, []);

  useAccountEffect({ onConnect, onDisconnect });

  // Catch the missed-transition race: Hydrate/reconnect can finish as `connected` before
  // watchAccount is subscribed, so onConnect never fires. Poll the live account and adopt.
  useEffect(() => {
    if (status !== "connected" || !connector || !address || chainId === undefined) return;
    if (walletManager.isWalletConnected("evm")) return;
    void adoptRef.current({
      address,
      addresses,
      chainId,
      connector,
      isReconnected: true,
    });
  }, [status, address, addresses, chainId, connector]);

  // Mid-handshake hang (injected provider never answers reconnectOnMount).
  useEffect(() => {
    if (status !== "connecting" && status !== "reconnecting") return;
    const timer = window.setTimeout(() => {
      console.error(
        `[wallet] wagmi status stuck at "${status}" for ${RECONNECT_WATCHDOG_MS}ms — forcing disconnect.`,
      );
      void disconnectAsync().catch(() => undefined);
    }, RECONNECT_WATCHDOG_MS);
    return () => window.clearTimeout(timer);
  }, [status, disconnectAsync]);

  // Connected in wagmi but never adopted into walletManager.
  useEffect(() => {
    if (status !== "connected") return;
    if (walletManager.isWalletConnected("evm")) return;
    const timer = window.setTimeout(() => {
      if (walletManager.isWalletConnected("evm")) return;
      console.error(
        `[wallet] wagmi connected but walletManager never adopted after ${ADOPT_STUCK_WATCHDOG_MS}ms — forcing disconnect.`,
      );
      void disconnectAsync().catch(() => undefined);
    }, ADOPT_STUCK_WATCHDOG_MS);
    return () => window.clearTimeout(timer);
  }, [status, address, disconnectAsync]);

  return null;
}
