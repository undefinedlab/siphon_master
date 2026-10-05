"use client";

import { useCallback, useEffect, useState } from "react";
import Nav from "@/components/theme/Nav";
import Nexus from "@/components/Nexus";
import TeeClientKeySync from "@/components/TeeClientKeySync";
import StrategyNoteReconciler from "@/components/StrategyNoteReconciler";
import WelcomeOnboarding from "@/components/onboarding/WelcomeOnboarding";
import DashboardTour, { type TourStop } from "@/components/onboarding/DashboardTour";
import NodeCanvasTourTrigger from "@/components/onboarding/NodeCanvasTourTrigger";
import { EthPriceProvider } from "@/lib/EthPriceProvider";
import { hasCompletedOnboarding, markOnboardingComplete } from "@/lib/onboarding";
import {
  applyPageBgTheme,
  loadDisplaySettings,
} from "@/components/widgets/config/dashboardDisplaySettings";
import { WalletInfo, walletManager } from "@/components/extensions/walletManager";
import styles from "@/app/hero.module.css";

// The node-canvas explainer is deferred (see NodeCanvasTourTrigger) — the canvas is a
// full-viewport region, so it doesn't read as a "highlight" until the user has actually opened it.
const INTRO_TOUR_STOPS: readonly TourStop[] = [
  {
    // Exactly the suggestions marquee + the input composer (field + send button) — not the
    // settings/widgets-toggle buttons flanking them, not the disclaimer text below.
    selectors: [".build-ai-marquee", ".build-ai-prompt-composer"],
    video: "/video_intro/ai_block_explainer.mp4",
    label: "Describe a strategy in plain English — AI drafts the blocks for you.",
    // Tall clip used to cover the composer it highlights. Keep it in the lower part of the screen.
    anchor: "bottom",
  },
  {
    selectors: ["#dashboard"],
    video: "/video_intro/widgets_explainer.mp4",
    label: "Pin the widgets that matter, wherever you want them.",
    widgetsVisible: true,
    // A modest step down from the AI stop's default — present, just a bit less intense.
    glowPad: 13,
    glowOpacity: 0.035,
    cardOffsetY: -64,
  },
];

export default function DappPage() {
  const [, setWalletConnected] = useState(false);
  const [, setConnectedWallet] = useState<WalletInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [dappMounted, setDappMounted] = useState(false);
  const [dappVisible, setDappVisible] = useState(false);

  useEffect(() => {
    applyPageBgTheme(loadDisplaySettings());
  }, []);

  useEffect(() => {
    const completed = hasCompletedOnboarding();
    if (completed) {
      setDappMounted(true);
      setDappVisible(true);
    } else {
      setShowOnboarding(true);
    }
    setReady(true);
  }, []);

  // Intro screen finishes → mount the real dashboard and hand off to the live spotlight tour.
  // Onboarding isn't marked complete until the tour itself finishes (see handleTourComplete).
  const handleOnboardingComplete = useCallback(() => {
    setShowOnboarding(false);
    setDappMounted(true);
    setShowTour(true);
    requestAnimationFrame(() => setDappVisible(true));
  }, []);

  const handleTourComplete = useCallback(() => {
    setShowTour(false);
    markOnboardingComplete();
    // Tell the deferred workers the gate is open. Everything that needs a wallet signature is held
    // back until onboarding finishes (WalletSessionBootstrap, TeeClientKeySync, BackupRetryDrainer)
    // so no prompt lands over the welcome guide. The first two poll and pick this up on their own;
    // the drainer is purely event-driven, so without this its queue would wait for the next tab
    // switch or reconnect.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("siphon:onboardingComplete"));
    }
  }, []);

  const handleWalletConnected = (wallet: WalletInfo) => {
    setWalletConnected(true);
    setConnectedWallet(wallet);
    walletManager.persistWallet(wallet);
  };

  return (
    <div style={{
      minHeight: "100vh",
      backgroundColor: "var(--build-page-bg, #000)",
      position: "relative",
    }}>
      {ready && showOnboarding && (
        <WelcomeOnboarding onComplete={handleOnboardingComplete} />
      )}

      {ready && dappMounted && (
        <EthPriceProvider>
        <>
          <div
            className={styles.heroContainer}
            style={{
              zIndex: 1,
              position: "fixed",
              inset: 0,
              width: "100%",
              height: "auto",
            }}
          >
            <svg className={styles.logo} viewBox="0 0 97.34 80">
              <path
                d="M70.66,35.93a11.66,11.66,0,0,1,1,.83c1.84,1.89,3.69,3.78,5.5,5.7,2.24,2.35,2.14,1.66-.06,3.9-4.47,4.53-9,9-13.49,13.49-1,1-1,1.09-.16,1.95q7.47,7.5,15,15c.85.85,1,.85,1.83,0q7.5-7.47,15-15c.84-.85.83-1,0-1.84-1.58-1.61-3.2-3.2-4.8-4.8l-9.72-9.73c-1.05-1-1-1.07,0-2.14.07-.08.15-.15.23-.23L92.22,32c1.5-1.47,3-2.94,4.49-4.43.86-.87.84-.9,0-1.81-.14-.16-.3-.3-.46-.46L81.59,10.63Q76.67,5.71,71.75.8c-1.07-1.07-1.09-1.07-2.17,0L64.82,5.66,37.45,33.19q-5.19,5.22-10.38,10.43c-.88.88-.9.87-1.77,0S23.83,42,23.08,41.26c-1.46-1.5-2.95-3-4.41-4.5-1.05-1.1-1-1.11,0-2.16l.23-.23Q25.94,27.28,33,20.19c1.08-1.08,1.09-1.08,0-2.16q-4.27-4.31-8.56-8.59c-2.06-2.06-4.11-4.13-6.18-6.17-.94-.93-1-.91-1.95,0-.2.18-.39.37-.58.56q-6.52,6.53-13,13c-.46.46-.92.91-1.36,1.38-.74.81-.73.88,0,1.73.18.2.37.38.56.57l8.81,8.81c1.83,1.83,3.64,3.67,5.49,5.49.54.52.62.95,0,1.46-.33.28-.62.61-.92.91L.85,51.75a3.65,3.65,0,0,0-.76.82,1.43,1.43,0,0,0,0,1c.1.28.42.48.64.71q12,12.45,24.05,24.89c1.1,1.14,1.11,1.14,2.28,0l29.48-29.3,13.2-13.1C70,36.47,70.3,36.24,70.66,35.93Z"
                fill="#ffffff"
              />
            </svg>

            <div className={styles.heroTextContainer}>
              <h1 className={styles.heroTitle}>siphon</h1>
              <p className={styles.heroSubtitle}>trade without a trace</p>
            </div>
          </div>

          <div
            style={{
              position: "fixed",
              inset: 0,
              width: "100%",
              height: "auto",
              backgroundColor: "var(--build-page-overlay, rgba(0, 0, 0, 0.97))",
              zIndex: 2,
              pointerEvents: "none",
            }}
          />

          <div
            style={{
              position: "fixed",
              inset: 0,
              width: "100%",
              height: "auto",
              zIndex: 1000,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "flex-start",
              pointerEvents: "none",
              overflow: "hidden",
              opacity: dappVisible ? 1 : 0,
              transition: "opacity 0.8s ease",
            }}
          >
            <div
              className="dapp-main-container"
              data-sensitive
              style={{
                height: "100%",
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                pointerEvents: dappVisible ? "auto" : "none",
                position: "relative",
                overflow: "hidden",
                width: "100%",
                alignSelf: "stretch",
              }}
            >
              <div
                className="dapp-nav-chrome"
                style={{
                  width: "100%",
                  pointerEvents: "auto",
                  position: "sticky",
                  top: 0,
                  zIndex: 10050,
                  flexShrink: 0,
                  overflow: "visible",
                }}
              >
                <Nav onWalletConnected={handleWalletConnected} />
              </div>

              <div
                className="dapp-container"
                style={{
                  width: "100%",
                  flex: 1,
                  maxWidth: "none",
                  pointerEvents: "auto",
                  position: "relative",
                  marginTop: "0",
                  overflowY: "auto",
                  overflowX: "hidden",
                  minHeight: 0,
                  WebkitOverflowScrolling: "touch",
                  background: "var(--build-page-bg, #000)",
                }}
              >
                <Nexus isLoaded={dappVisible} />
                <TeeClientKeySync />
                <StrategyNoteReconciler />
              </div>
            </div>
          </div>
        </>
        </EthPriceProvider>
      )}

      {ready && dappVisible && showTour && (
        <DashboardTour stops={INTRO_TOUR_STOPS} onComplete={handleTourComplete} />
      )}

      {ready && dappVisible && !showTour && <NodeCanvasTourTrigger />}
    </div>
  );
}
