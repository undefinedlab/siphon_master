"use client";

import { createContext, memo, useContext, type ReactNode } from "react";
import type { NodeProps } from "@xyflow/react";
import { CustomNode } from "./BuildNodes";
import { RepeatGroupNode } from "./RepeatGroupNode";

import type { SimHighlightStatus } from "./useCanvasSimulation";

export interface BuildFlowContextValue {
  updateNodeData: (nodeId: string, field: string, value: string) => void;
  tokens: string[];
  isTokenActive: (token: string) => boolean;
  simHighlight?: Record<string, SimHighlightStatus>;
  simShakingId?: string | null;
  simExiting?: boolean;
}

const BuildFlowContext = createContext<BuildFlowContextValue | null>(null);

export function BuildFlowContextProvider({
  value,
  children,
}: {
  value: BuildFlowContextValue;
  children: ReactNode;
}) {
  return <BuildFlowContext.Provider value={value}>{children}</BuildFlowContext.Provider>;
}

function CustomNodeFlow(props: NodeProps) {
  const ctx = useContext(BuildFlowContext);
  if (!ctx) return null;
  return (
    <CustomNode
      id={props.id}
      data={props.data}
      updateNodeData={ctx.updateNodeData}
      tokens={ctx.tokens}
      isTokenActive={ctx.isTokenActive}
      simStatus={ctx.simHighlight?.[props.id]}
      simShaking={ctx.simShakingId === props.id}
      simExiting={ctx.simExiting}
    />
  );
}

function RepeatGroupFlow(props: NodeProps) {
  const ctx = useContext(BuildFlowContext);
  if (!ctx) return null;
  return (
    <RepeatGroupNode
      id={props.id}
      data={props.data}
      selected={props.selected}
      updateNodeData={ctx.updateNodeData}
      simStatus={ctx.simHighlight?.[props.id]}
      simShaking={ctx.simShakingId === props.id}
      simExiting={ctx.simExiting}
    />
  );
}

export const FLOW_NODE_TYPES = {
  custom: memo(CustomNodeFlow),
  repeatGroup: memo(RepeatGroupFlow),
};
