"use client";

/**
 * The node-canvas explainer isn't shown upfront (the canvas is a full-viewport region — spotlighting
 * it as one of several sequential tour stops doesn't read as a "highlight" of anything in particular).
 * Instead, it's held back and shown the first time the user actually opens/expands the node canvas —
 * Build.tsx already dispatches 'build-view-expanded' exactly when that happens.
 */

import { useEffect, useState } from "react";
import DashboardTour, { type TourStop } from "./DashboardTour";
import { hasSeenNodeTour, markNodeTourSeen } from "@/lib/onboarding";

const NODE_STOP: TourStop = {
  // The canvas itself fills the whole viewport (nothing sane to spotlight there), so this stop
  // highlights the top action bar (Save/Run/Smoke, BuildNav.tsx) and the chat input field instead.
  selectors: [".blueprint-top-bar", ".build-ai-prompt-composer"],
  video: "/video_intro/node_system_explainer.mp4",
  label: "Drag, connect, and tune nodes into any strategy shape.",
};

export default function NodeCanvasTourTrigger() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (hasSeenNodeTour()) return;
    const onExpanded = (e: Event) => {
      const expanded = (e as CustomEvent<boolean>).detail;
      if (expanded && !hasSeenNodeTour()) setShow(true);
    };
    window.addEventListener("build-view-expanded", onExpanded);
    return () => window.removeEventListener("build-view-expanded", onExpanded);
  }, []);

  if (!show) return null;

  return (
    <DashboardTour
      stops={[NODE_STOP]}
      restoreWidgetsOnFinish={false}
      onComplete={() => {
        markNodeTourSeen();
        setShow(false);
      }}
    />
  );
}
