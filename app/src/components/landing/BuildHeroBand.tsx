"use client";

import { useEffect, useState } from "react";
import BuildAiPrompt, { type BuildChatMessage } from "@/components/navs/Builder/BuildAiPrompt";
import {
  DashboardCustomizePanel,
  useDashboardCustomize,
} from "@/components/landing/dashboard-customize-context";

const SWAP_FADE_MS = 380;

type BuildHeroBandProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (prompt: string) => void | Promise<void>;
  isLoading: boolean;
  messages: BuildChatMessage[];
  onChatActiveChange: (active: boolean) => void;
  widgetsVisible: boolean;
  onToggleWidgets?: () => void;
  buildViewActive: boolean;
};

export function BuildHeroBand(props: BuildHeroBandProps) {
  const { panelOpen, themeClassName } = useDashboardCustomize();
  const [layoutExpanded, setLayoutExpanded] = useState(panelOpen);

  useEffect(() => {
    if (panelOpen) {
      setLayoutExpanded(true);
      return;
    }
    const timer = window.setTimeout(() => setLayoutExpanded(false), SWAP_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [panelOpen]);

  return (
    <div
      className={[
        "build-hero-band",
        themeClassName,
        layoutExpanded ? "build-hero-band--customizing" : "",
        panelOpen ? "build-hero-band--library-visible" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="build-hero-swap">
        <div
          className="build-hero-swap-pane build-hero-swap-pane--chat"
          aria-hidden={panelOpen}
        >
          <BuildAiPrompt {...props} />
        </div>
        <div
          className="build-hero-swap-pane build-hero-swap-pane--library"
          aria-hidden={!panelOpen}
        >
          <DashboardCustomizePanel variant="hero" />
        </div>
      </div>
    </div>
  );
}
