'use client';

import { useEffect, useState } from 'react';
import { showAppToast } from '../lib/appToast';
import {
  DEFAULT_CHAIN_ID,
  getNetwork,
  getSelectedChainId,
  installWalletChainSync,
  selectChainAndSwitchWallet,
  visibleChainIds,
} from '../lib/networks';
import { resolveWalletAddress } from '../lib/walletAddress';

type ChainToggleProps = {
  className?: string;
  badgeClassName?: string;
};

export default function ChainToggle({ className, badgeClassName = 'strategy-modal-category-badge' }: ChainToggleProps) {
  const [chainId, setChainId] = useState(DEFAULT_CHAIN_ID);
  const [switching, setSwitching] = useState(false);
  const [wallet, setWallet] = useState<string | null>(null);
  const chains = visibleChainIds(wallet);

  useEffect(() => {
    installWalletChainSync();
    setChainId(getSelectedChainId());
    const refreshWallet = () => setWallet(resolveWalletAddress());
    refreshWallet();
    const onChain = (e: Event) => {
      const id = (e as CustomEvent<{ chainId: number }>).detail?.chainId;
      if (id) setChainId(id);
    };
    window.addEventListener('siphon:chainChanged', onChain);
    window.addEventListener('siphon:walletChainChanged', onChain);
    window.addEventListener('walletConnected', refreshWallet);
    window.addEventListener('walletDisconnected', refreshWallet);
    return () => {
      window.removeEventListener('siphon:chainChanged', onChain);
      window.removeEventListener('siphon:walletChainChanged', onChain);
      window.removeEventListener('walletConnected', refreshWallet);
      window.removeEventListener('walletDisconnected', refreshWallet);
    };
  }, []);

  const selectChain = async (id: number) => {
    if (switching) return;
    setSwitching(true);
    try {
      const result = await selectChainAndSwitchWallet(id, wallet);
      if (!result.ok) {
        showAppToast(`Could not switch network: ${result.error}`, 'error');
        setChainId(result.chainId);
        return;
      }
      setChainId(result.chainId);
      window.dispatchEvent(new CustomEvent('siphon:networkReady', { detail: { chainId: result.chainId } }));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className={className} role="group" aria-label="EVM network">
      {chains.map((id) => {
        const net = getNetwork(id);
        const active = id === chainId;
        return (
          <button
            key={id}
            type="button"
            className={`${badgeClassName} ${active ? 'active' : 'inactive'}`}
            onClick={() => selectChain(id)}
            disabled={switching}
            title={net.name}
          >
            {net.shortName}
          </button>
        );
      })}
    </div>
  );
}
