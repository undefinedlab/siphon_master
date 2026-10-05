'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import WalletSelector from './WalletSelector';
import HomeChainPicker from './HomeChainPicker';
import { walletManager, WalletInfo } from './walletManager';
import { showAppToast } from '@/lib/appToast';
import { useProductChain } from '@/lib/chains/ChainModeContext';
import { setSelectedChainId } from '@/lib/networks';
import { isAdminWallet } from '@/lib/adminWalletCore';
import {
  SOLANA_EDGE_CHAIN_ID,
  clearStoredHomeChainId,
  readStoredHomeChainId,
  resolveHomeChainOption,
  writeStoredHomeChainId,
  type HomeChainOption,
} from '@/lib/chains/homeChains';

/** Brief window where we prefer waiting for silent reconnect over opening a new modal. */
const SYNC_SOFT_BLOCK_MS = 2_000;

export default function ConnectButton({ className, onConnected }: { className?: string; onConnected?: (wallet: WalletInfo) => void }) {
  const [connectedWallet, setConnectedWallet] = useState<WalletInfo | null>(null);
  const [syncSoftBlocked, setSyncSoftBlocked] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // RainbowKit only exposes openConnectModal while wagmi is disconnected, so a home-chain switch
  // (which disconnects first) cannot call the one captured at click time — it is still undefined.
  // Ask for the modal here and open it once RainbowKit hands it over.
  const [modalPending, setModalPending] = useState(false);
  const { openConnectModal } = useConnectModal();
  const { disconnectAsync } = useDisconnect();
  const { connectSolana, solanaSession, setChainId: setProductChainId } = useProductChain();
  // Two gaps stack before connectedWallet is set: wagmi's connect/reconnect handshake, then our
  // async adoption (EvmWalletBridge → walletManager). RainbowKit withholds openConnectModal for
  // the whole isConnected span — not just isConnecting/isReconnecting — so we track that gap,
  // but only soft-block briefly; after that a click recovers by disconnecting + opening the modal.
  const { isConnected, isConnecting, isReconnecting } = useAccount();
  const wagmiBusy = isConnecting || isReconnecting || (isConnected && !connectedWallet);
  const walletSyncing = wagmiBusy && syncSoftBlocked;
  const recoveringRef = useRef(false);

  useEffect(() => {
    if (!wagmiBusy) {
      setSyncSoftBlocked(false);
      return;
    }
    setSyncSoftBlocked(true);
    const timer = window.setTimeout(() => setSyncSoftBlocked(false), SYNC_SOFT_BLOCK_MS);
    return () => window.clearTimeout(timer);
  }, [wagmiBusy]);

  useEffect(() => {
    if (!modalPending) return;
    if (openConnectModal) {
      setModalPending(false);
      openConnectModal();
      return;
    }
    const timer = window.setTimeout(() => {
      setModalPending(false);
      showAppToast('Wallet connect isn’t ready yet — reload and try again.', 'error');
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [modalPending, openConnectModal]);

  // Adoption can finish without a React re-render dependency flipping — poll while wagmi is busy.
  useEffect(() => {
    if (connectedWallet || !wagmiBusy) return;
    const tick = () => {
      const wallet = walletManager.getPrimaryWallet() ?? null;
      if (wallet) setConnectedWallet(wallet);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [connectedWallet, wagmiBusy]);

  // Restore Phantom session into walletManager when home chain is Solana.
  useEffect(() => {
    if (!solanaSession?.address) return;
    const home = resolveHomeChainOption(readStoredHomeChainId());
    if (home?.kind !== 'solana') return;
    const adopted = walletManager.adoptSolanaWallet({ address: solanaSession.address });
    if (adopted.wallet) setConnectedWallet(adopted.wallet);
  }, [solanaSession?.address]);

  const connectSolanaHome = useCallback(async (option: HomeChainOption) => {
    if (!option.productChainId || option.numericId == null) {
      showAppToast('Solana home chain is not configured.', 'error');
      return;
    }
    writeStoredHomeChainId(option.id);
    setProductChainId(option.productChainId);
    setSelectedChainId(option.numericId);
    try {
      const session = await connectSolana();
      const result = walletManager.adoptSolanaWallet({ address: session.address, name: 'Phantom' });
      if (result.success && result.wallet) {
        setConnectedWallet(result.wallet);
        onConnected?.(result.wallet);
        showAppToast(`Phantom connected · ${option.label}${option.tag ? ` (${option.tag})` : ''}`, 'success');
      } else {
        showAppToast(result.error || 'Failed to connect Phantom', 'error');
      }
    } catch (error) {
      showAppToast(
        error instanceof Error ? error.message : 'Connect Phantom to use Solana.',
        'error',
      );
    }
  }, [connectSolana, onConnected, setProductChainId]);

  const connectEvmHome = useCallback(async (option: HomeChainOption) => {
    if (!option.productChainId || option.numericId == null) {
      showAppToast('EVM home chain is not configured.', 'error');
      return;
    }
    writeStoredHomeChainId(option.id);
    setProductChainId(option.productChainId);
    setSelectedChainId(option.numericId);

    // Solana home on mainnet: the vault is the EVM wallet, Phantom funds and receives. Ask for
    // Phantom first so the EVM modal is the last thing on screen; skipping it is fine — Deposit
    // asks again when funding from Solana.
    if (option.edgeChainId === SOLANA_EDGE_CHAIN_ID && !solanaSession?.address) {
      await connectSolana().catch(() => {
        showAppToast('Phantom skipped — connect it from Deposit to fund from Solana.', 'info');
      });
    }

    if (wagmiBusy && !recoveringRef.current) {
      recoveringRef.current = true;
      try {
        await disconnectAsync().catch(() => undefined);
        walletManager.disconnectWallet('evm');
        setConnectedWallet(null);
      } finally {
        recoveringRef.current = false;
      }
    }

    setModalPending(true);
  }, [connectSolana, disconnectAsync, setProductChainId, solanaSession?.address, wagmiBusy]);

  const applyHomeChain = useCallback(async (option: HomeChainOption) => {
    setPickerOpen(false);
    if (option.kind === 'soon') return;

    // Switching home chain: drop the previous session so the new vault/wallet path is clean.
    try {
      walletManager.disconnectWallet('evm');
      walletManager.disconnectWallet('solana');
      walletManager.clearPersistedWallet();
      setConnectedWallet(null);
      await disconnectAsync().catch(() => undefined);
    } catch {
      /* best-effort */
    }

    if (option.kind === 'solana') {
      await connectSolanaHome(option);
      return;
    }
    await connectEvmHome(option);
  }, [connectEvmHome, connectSolanaHome, disconnectAsync]);

  const handleConnectClick = useCallback(async () => {
    if (walletSyncing) {
      showAppToast('Still restoring your wallet session — one moment.', 'info');
      return;
    }

    const stored = resolveHomeChainOption(readStoredHomeChainId());
    if (stored) {
      // Returning user — skip picker, open the matching wallet for their home chain.
      await applyHomeChain(stored);
      return;
    }

    setPickerOpen(true);
  }, [applyHomeChain, walletSyncing]);

  const syncConnectedWallet = useCallback(async () => {
    const restored = await walletManager.restorePersistedSession();
    const wallet = restored ?? walletManager.getPrimaryWallet() ?? null;
    setConnectedWallet(wallet);
    return wallet;
  }, []);

  useEffect(() => {
    void syncConnectedWallet();
  }, [syncConnectedWallet]);

  useEffect(() => {
    const handleWalletConnected = () => {
      void syncConnectedWallet().then((wallet) => {
        if (!wallet) return;
        // An admin-only testnet home (ETH / Tempo / Hyperliquid) picked by a non-admin: undo.
        if (resolveHomeChainOption(readStoredHomeChainId())?.adminOnly && !isAdminWallet(wallet.address)) {
          clearStoredHomeChainId();
          walletManager.disconnectWallet('evm');
          walletManager.clearPersistedWallet();
          setConnectedWallet(null);
          void disconnectAsync().catch(() => undefined);
          showAppToast('That testnet is limited to admin wallets — pick another network.', 'error');
          setPickerOpen(true);
          return;
        }
        onConnected?.(wallet);
      });
    };

    const handleWalletDisconnected = () => {
      setConnectedWallet(null);
    };

    const handleTriggerConnection = () => {
      if (!walletManager.hasActiveSession()) {
        void handleConnectClick();
      }
    };

    const handleChangeHomeChain = () => {
      setPickerOpen(true);
    };

    window.addEventListener('walletConnected', handleWalletConnected);
    window.addEventListener('walletDisconnected', handleWalletDisconnected);
    window.addEventListener('triggerWalletConnection', handleTriggerConnection);
    window.addEventListener('siphon:changeHomeChain', handleChangeHomeChain);

    return () => {
      window.removeEventListener('walletConnected', handleWalletConnected);
      window.removeEventListener('walletDisconnected', handleWalletDisconnected);
      window.removeEventListener('triggerWalletConnection', handleTriggerConnection);
      window.removeEventListener('siphon:changeHomeChain', handleChangeHomeChain);
    };
  }, [syncConnectedWallet, onConnected, handleConnectClick, disconnectAsync]);

  const handleDashboardClick = () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('userdash-view-change', { detail: 'userdash' }));
      window.dispatchEvent(new CustomEvent('pro-view-mode-change', { detail: 'userdash' }));
    }
  };

  return (
    <>
      <HomeChainPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(opt) => { void applyHomeChain(opt); }}
      />

      {connectedWallet ? (
        <div className={`wallet-container ${className ?? ""}`}>
          <button
            className="wallet-connected-button"
            onClick={handleDashboardClick}
            title="Open dashboard"
          >
            <div className="wallet-info-block">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12v-2a5 5 0 0 0-5-5H8a5 5 0 0 0-5 5v2" />
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v6m0 6v6" />
              </svg>
              <span className="wallet-balance-text">Dashboard</span>
            </div>
          </button>
        </div>
      ) : (
        <WalletSelector className={className} onClick={() => { void handleConnectClick(); }} syncing={walletSyncing} />
      )}
    </>
  );
}
