"use client";

import { useCallback, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import { runStrategySimulation } from "../../../lib/strategySimulation";

export type SimHighlightStatus = "checking" | "ok" | "error";

export interface SimToastState {
  message: string;
  type: "error" | "success";
}

const STEP_MS = 520;
const HOLD_VISIBLE_MS = 3200;
const FADE_DURATION_MS = 900;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useCanvasSimulation(nodes: Node[], edges: Edge[]) {
  const [simHighlight, setSimHighlight] = useState<Record<string, SimHighlightStatus>>({});
  const [simShakingId, setSimShakingId] = useState<string | null>(null);
  const [simToast, setSimToast] = useState<SimToastState | null>(null);
  const [simExiting, setSimExiting] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const runIdRef = useRef(0);
  const fadeTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearFadeTimers = useCallback(() => {
    for (const timer of fadeTimersRef.current) clearTimeout(timer);
    fadeTimersRef.current = [];
  }, []);

  const scheduleSimulationCleanup = useCallback(
    (runId: number) => {
      clearFadeTimers();
      const fadeStart = setTimeout(() => {
        if (runId !== runIdRef.current) return;
        setSimExiting(true);
        const fadeEnd = setTimeout(() => {
          if (runId !== runIdRef.current) return;
          setSimHighlight({});
          setSimShakingId(null);
          setSimToast(null);
          setSimExiting(false);
        }, FADE_DURATION_MS);
        fadeTimersRef.current.push(fadeEnd);
      }, HOLD_VISIBLE_MS);
      fadeTimersRef.current.push(fadeStart);
    },
    [clearFadeTimers]
  );

  const dismissToast = useCallback(() => {
    clearFadeTimers();
    setSimToast(null);
    setSimExiting(false);
  }, [clearFadeTimers]);

  const clearSimulation = useCallback(() => {
    runIdRef.current += 1;
    clearFadeTimers();
    setIsSimulating(false);
    setSimHighlight({});
    setSimShakingId(null);
    setSimToast(null);
    setSimExiting(false);
  }, [clearFadeTimers]);

  const runSimulation = useCallback(async () => {
    runIdRef.current += 1;
    const runId = runIdRef.current;
    clearFadeTimers();

    const result = runStrategySimulation(nodes, edges);

    setIsSimulating(true);
    setSimHighlight({});
    setSimShakingId(null);
    setSimToast(null);
    setSimExiting(false);

    if (result.steps.length === 0) {
      setSimToast({
        type: "error",
        message: result.issues[0]?.message ?? result.summary,
      });
      setIsSimulating(false);
      scheduleSimulationCleanup(runId);
      return;
    }

    for (const step of result.steps) {
      if (runId !== runIdRef.current) return;

      setSimHighlight((prev) => ({ ...prev, [step.nodeId]: "checking" }));
      await sleep(STEP_MS * 0.35);

      if (runId !== runIdRef.current) return;

      const failed = step.status === "error";
      setSimHighlight((prev) => ({
        ...prev,
        [step.nodeId]: failed ? "error" : "ok",
      }));

      if (failed) {
        const issue = result.issues.find((i) => i.nodeId === step.nodeId);
        setSimShakingId(step.nodeId);
        setSimToast({
          type: "error",
          message: issue?.message ?? step.message,
        });
        setIsSimulating(false);
        setTimeout(() => {
          if (runId === runIdRef.current) setSimShakingId(null);
        }, 480);
        scheduleSimulationCleanup(runId);
        return;
      }

      await sleep(STEP_MS * 0.65);
    }

    if (runId !== runIdRef.current) return;

    setIsSimulating(false);
    setSimToast({ type: "success", message: result.summary });
    scheduleSimulationCleanup(runId);
  }, [nodes, edges, clearFadeTimers, scheduleSimulationCleanup]);

  return {
    simHighlight,
    simShakingId,
    simToast,
    simExiting,
    isSimulating,
    runSimulation,
    clearSimulation,
    dismissToast,
  };
}
