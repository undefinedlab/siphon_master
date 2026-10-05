"use client";

import { createContext, useContext, type ReactNode } from "react";

export type RunningStrategyEntry = {
  startTime: number;
  isRunning: boolean;
  loop: boolean;
};

type RunningStrategiesContextValue = {
  runningStrategies: Map<string, RunningStrategyEntry>;
};

const RunningStrategiesContext = createContext<RunningStrategiesContextValue>({
  runningStrategies: new Map(),
});

export function RunningStrategiesProvider({
  runningStrategies,
  children,
}: {
  runningStrategies: Map<string, RunningStrategyEntry>;
  children: ReactNode;
}) {
  return (
    <RunningStrategiesContext.Provider value={{ runningStrategies }}>
      {children}
    </RunningStrategiesContext.Provider>
  );
}

export function useRunningStrategies() {
  return useContext(RunningStrategiesContext).runningStrategies;
}
