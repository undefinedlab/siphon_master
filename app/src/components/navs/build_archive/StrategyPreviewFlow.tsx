"use client";

import { useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./BuildNodes.css";
import { PREVIEW_FLOW_NODE_TYPES } from "./previewFlowNodeTypes";

interface StrategyPreviewFlowProps {
  nodes: Node[];
  edges: Edge[];
  flowKey: number;
  isLoading?: boolean;
  minHeight?: number;
}

export default function StrategyPreviewFlow({
  nodes,
  edges,
  flowKey,
  isLoading = false,
  minHeight = 240,
}: StrategyPreviewFlowProps) {
  const flowRef = useRef<HTMLDivElement>(null);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);

  if (isLoading) {
    return (
      <div className="strategy-preview-placeholder">
        <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
        <p>Loading strategy preview...</p>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="strategy-preview-placeholder">
        <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
        <p>No strategy preview available</p>
      </div>
    );
  }

  return (
    <div ref={flowRef} style={{ width: "100%", height: "100%", minHeight, position: "relative" }}>
      <ReactFlowProvider key={flowKey}>
        <ReactFlow
          key={`flow-${flowKey}`}
          nodes={nodes}
          edges={edges}
          onInit={(instance) => {
            reactFlowInstance.current = instance;
            setTimeout(() => {
              instance.fitView({ padding: 0.2, duration: 400 });
            }, 100);
          }}
          nodeTypes={PREVIEW_FLOW_NODE_TYPES}
          defaultEdgeOptions={{
            style: { stroke: "rgba(255, 255, 255, 0.3)", strokeWidth: 2 },
            type: "smoothstep",
          }}
          fitView
          minZoom={0.3}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          proOptions={{ hideAttribution: true }}
        >
          <Background color="rgba(255, 255, 255, 0.02)" gap={16} size={1} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
