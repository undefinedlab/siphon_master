'use client';

interface WalletSelectorProps {
  onClick: () => void;
  className?: string;
  /** wagmi is silently restoring a previous session — openConnectModal is legitimately withheld
   * during this window, so the label says so instead of looking like a plain, actionable button. */
  syncing?: boolean;
}

/**
 * "Connect Wallet" trigger — opens RainbowKit's connect modal (see ConnectButton).
 * Deliberately never `disabled`: gating this on RainbowKit's own connectModalOpen state means a
 * single stuck internal flag (the exact class of bug this app hit earlier with WalletConnect init)
 * permanently deadens the button with zero console error. Calling openConnectModal() again while
 * it's already open is a harmless no-op, so there's nothing to protect against here.
 */
export default function WalletSelector({ onClick, className, syncing = false }: WalletSelectorProps) {
  return (
    <div className={`wallet-selector ${className ?? ''}`}>
      <button type="button" className="wallet-selector-trigger" onClick={onClick} aria-busy={syncing}>
        <span className="wallet-icon"></span>
        <span className="wallet-text">{syncing ? 'Restoring…' : 'Connect Wallet'}</span>
        <span className="dropdown-arrow">▼</span>
      </button>
    </div>
  );
}
