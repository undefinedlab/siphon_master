"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import ConnectButton from "../extensions/ConnectButton";
import { WalletInfo } from "../extensions/walletManager";

interface NavProps {
  onWalletConnected?: (wallet: WalletInfo) => void;
}

export default function Nav({ onWalletConnected }: NavProps) {
  const pathname = usePathname();
  const router = useRouter();
  // Marketing landing lives at /landing; / and /dapp are the product UI.
  const isHomePage = pathname === "/landing";
  const isDappPage = pathname === "/" || pathname?.startsWith("/dapp");
  const isDarkPool = pathname === "/dapp/darkpool";
  const isSwaps = pathname === "/dapp/swaps";
  const isPro = pathname === "/" || pathname === "/dapp" || pathname === "/dapp/pro";
  
  const [proViewMode, setProViewMode] = useState<'blueprint' | 'run' | 'discover' | 'markets' | 'userdash'>('blueprint');

  useEffect(() => {
    const handleViewModeChange = (event: CustomEvent) => {
      const mode = event.detail as 'blueprint' | 'run' | 'discover' | 'markets' | 'userdash';
      if (mode === 'userdash') {
        setProViewMode('userdash');
        return;
      }
      if (mode === 'discover' || mode === 'markets') {
        setProViewMode('blueprint');
        return;
      }
      setProViewMode(mode);
    };

    window.addEventListener('pro-view-mode-change', handleViewModeChange as EventListener);
    window.addEventListener('userdash-view-change', handleViewModeChange as EventListener);
    return () => {
      window.removeEventListener('pro-view-mode-change', handleViewModeChange as EventListener);
      window.removeEventListener('userdash-view-change', handleViewModeChange as EventListener);
    };
  }, []);

  const handleProViewModeChange = (mode: 'blueprint' | 'run' | 'discover' | 'markets') => {
    const resolved = mode === 'discover' || mode === 'markets' ? 'blueprint' : mode;
    setProViewMode(resolved);
    // Navigate to dapp page if not already there
    if (!isPro) {
      router.push('/');
    }
    // Trigger view mode change event for Nexus component
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('pro-view-mode-change', { detail: resolved }));
    }
  };

  const isBuildMode = proViewMode === 'blueprint';
  const isUserDash = proViewMode === 'userdash';
  const showDappCenterNav = isDappPage && !isBuildMode && !isUserDash;

  const handleLogoClick = (event: React.MouseEvent) => {
    if (!isDappPage) return;
    event.preventDefault();
    // Always return to the builder landing (home), even from build mode or a loaded strategy:
    // switch to the blueprint view AND clear any loaded graph so the dashboard shows.
    window.dispatchEvent(new CustomEvent('userdash-view-change', { detail: 'blueprint' }));
    window.dispatchEvent(new CustomEvent('pro-view-mode-change', { detail: 'blueprint' }));
    window.dispatchEvent(new CustomEvent('siphon:go-home'));
  };

  const logoContent = (
    <div className="logo-container">
      <svg width="24" height="20" viewBox="0 0 97.34 80" className="logo-svg">
        <path d="M70.66,35.93a11.66,11.66,0,0,1,1,.83c1.84,1.89,3.69,3.78,5.5,5.7,2.24,2.35,2.14,1.66-.06,3.9-4.47,4.53-9,9-13.49,13.49-1,1-1,1.09-.16,1.95q7.47,7.5,15,15c.85.85,1,.85,1.83,0q7.5-7.47,15-15c.84-.85.83-1,0-1.84-1.58-1.61-3.2-3.2-4.8-4.8l-9.72-9.73c-1.05-1-1-1.07,0-2.14.07-.08.15-.15.23-.23L92.22,32c1.5-1.47,3-2.94,4.49-4.43.86-.87.84-.9,0-1.81-.14-.16-.3-.3-.46-.46L81.59,10.63Q76.67,5.71,71.75.8c-1.07-1.07-1.09-1.07-2.17,0L64.82,5.66,37.45,33.19q-5.19,5.22-10.38,10.43c-.88.88-.9.87-1.77,0S23.83,42,23.08,41.26c-1.46-1.5-2.95-3-4.41-4.5-1.05-1.1-1-1.11,0-2.16l.23-.23Q25.94,27.28,33,20.19c1.08-1.08,1.09-1.08,0-2.16q-4.27-4.31-8.56-8.59c-2.06-2.06-4.11-4.13-6.18-6.17-.94-.93-1-.91-1.95,0-.2.18-.39.37-.58.56q-6.52,6.53-13,13c-.46.46-.92.91-1.36,1.38-.74.81-.73.88,0,1.73.18.2.37.38.56.57l8.81,8.81c1.83,1.83,3.64,3.67,5.49,5.49.54.52.62.95,0,1.46-.33.28-.62.61-.92.91L.85,51.75a3.65,3.65,0,0,0-.76.82,1.43,1.43,0,0,0,0,1c.1.28.42.48.64.71q12,12.45,24.05,24.89c1.1,1.14,1.11,1.14,2.28,0l29.48-29.3,13.2-13.1C70,36.47,70.3,36.24,70.66,35.93Z" fill="currentColor"/>
      </svg>
      <p>Siphon Protocol</p>
    </div>
  );

  return (
    <nav>
      <div className="nav-container">
        {/* Left: Logo */}
        <div className="logo">
        {isDappPage ? (
          <button type="button" className="logo-link" onClick={handleLogoClick} aria-label="Back to builder">
            {logoContent}
          </button>
        ) : (
          <Link href="/" className="logo-link">
            {logoContent}
          </Link>
        )}
      </div>

      {/* Center: Menu Buttons (hidden on build and user dashboard) */}
      {showDappCenterNav && (
        <div className="nav-center">
          <>
              <div 
                className={`nav-single-btn nav-single-btn-disabled ${isDarkPool ? 'active' : ''}`}
              >
                <div className="nav-single-btn-content">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                  Darkpools
                </div>
                <span className="nav-soon-tag">soon</span>
              </div>
              <div 
                className={`nav-single-btn nav-single-btn-disabled ${isSwaps ? 'active' : ''}`}
              >
                <div className="nav-single-btn-content">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 3L4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />
                  </svg>
                  Swap
                </div>
                <span className="nav-soon-tag">soon</span>
              </div>
              <div className="nav-divider"></div>
          </>
          <div className="nav-mode-selector">
            {/* This block only renders when showDappCenterNav is true, i.e. NOT in blueprint
                mode (see showDappCenterNav = …&& !isBuildMode), so this "go to Build" button is
                never in the active state here — hence no active-class check. */}
            <button
              className="nav-mode-btn"
              onClick={() => handleProViewModeChange('blueprint')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
              Build
            </button>
          </div>
        </div>
      )}

      {/* Right: Menu Buttons for Home, Wallet for Dapp */}
      {isHomePage && (
        <div className="nav-right">
          <div className="nav-mode-selector">
            <a
              href="https://docs.siphon.money"
              className="nav-mode-btn"
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
              </svg>
              docs
            </a>
            <Link
              href="/"
              className={`nav-mode-btn ${isDappPage ? 'active' : ''}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
              dapp
            </Link>
          </div>
        </div>
      )}

      {/* Right: Wallet on dapp */}
      {isDappPage && (
        <div className="nav-wallet">
          <ConnectButton 
            className="top-connect-button"
            onConnected={onWalletConnected}
          />
        </div>
      )}
      </div>
    </nav>
  );
}


