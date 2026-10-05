"use client";

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { ScheduleUnit } from "../../../lib/strategySpec";
import "./RepeatGroupNode.css";

export interface PreviewNodeData {
  label?: string;
  type?: string;
  coin?: string;
  toCoin?: string;
  amount?: string;
  strategy?: string;
  chain?: string;
  repeatMode?: string;
  repeatCount?: string;
  loopIntervalValue?: string;
  loopIntervalUnit?: string;
  childCount?: number;
  [key: string]: unknown;
}

function PreviewCustomNode({ data }: { data: PreviewNodeData }) {
  const nodeData = data;
  const isStrategy = nodeData.type === "strategy";

  return (
    <div
      className={`custom-node ${isStrategy ? "strategy-node" : ""}`}
      style={{
        position: "relative",
        background: isStrategy ? "rgba(255, 193, 7, 0.2)" : undefined,
        border: isStrategy ? "1px solid rgba(255, 193, 7, 0.5)" : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "rgba(255, 255, 255, 0.3)" }} />
      <div className="node-content">
        <div className="node-title">{nodeData.label}</div>
        {nodeData.type === "deposit" && nodeData.coin && (
          <div className="node-preview-info" style={{ fontSize: "10px", color: "rgba(255, 255, 255, 0.7)", marginTop: "0.5rem" }}>
            {nodeData.coin} {nodeData.amount ? `- ${nodeData.amount}` : ""}
          </div>
        )}
        {nodeData.type === "swap" && (
          <div className="node-preview-info" style={{ fontSize: "10px", color: "rgba(255, 255, 255, 0.7)", marginTop: "0.5rem" }}>
            {nodeData.coin || "From"} → {nodeData.toCoin || "To"} {nodeData.amount ? `- ${nodeData.amount}` : ""}
          </div>
        )}
        {nodeData.type === "withdraw" && (
          <div className="node-preview-info" style={{ fontSize: "10px", color: "rgba(255, 255, 255, 0.7)", marginTop: "0.5rem" }}>
            {nodeData.coin || "Coin"} {nodeData.amount ? `- ${nodeData.amount}` : ""}
          </div>
        )}
        {nodeData.type === "strategy" && nodeData.strategy && (
          <div className="node-preview-info" style={{ fontSize: "10px", color: "rgba(255, 255, 255, 0.7)", marginTop: "0.5rem" }}>
            {nodeData.strategy} {nodeData.coin ? `- ${nodeData.coin}` : ""} {nodeData.amount ? `- ${nodeData.amount}` : ""}
          </div>
        )}
        {nodeData.chain && (
          <div className="node-preview-info" style={{ fontSize: "9px", color: "rgba(255, 255, 255, 0.5)", marginTop: "0.25rem" }}>
            {nodeData.chain}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "rgba(255, 255, 255, 0.3)" }} />
    </div>
  );
}

function PreviewRepeatGroupNode({ data }: { data: PreviewNodeData }) {
  const mode = String(data.repeatMode || "until_funds").toLowerCase() === "count" ? "count" : "until_funds";
  const loopUnit = (data.loopIntervalUnit as ScheduleUnit) || "hours";

  return (
    <div className="repeat-group-node">
      <Handle type="target" position={Position.Left} className="repeat-group-handle" />
      <div className="repeat-group-header">
        <span className="repeat-group-title">Loop</span>
        <span className="repeat-group-select repeat-group-select--mode" style={{ pointerEvents: "none" }}>
          {mode === "count" ? "N times" : "Until funds end"}
        </span>
        {mode === "count" && data.repeatCount && (
          <span className="repeat-group-input repeat-group-input--count" style={{ pointerEvents: "none" }}>
            {data.repeatCount}
          </span>
        )}
        <span className="repeat-group-each-label">Each</span>
        <span className="repeat-group-input repeat-group-input--interval" style={{ pointerEvents: "none" }}>
          {data.loopIntervalValue || "—"}
        </span>
        <span className="repeat-group-select repeat-group-select--unit" style={{ pointerEvents: "none" }}>
          {loopUnit}
        </span>
        <span className="repeat-group-block-count">
          {data.childCount ? `${data.childCount} block${data.childCount !== 1 ? "s" : ""}` : "0 blocks"}
        </span>
      </div>
      <div className="repeat-group-body" />
      <Handle type="source" position={Position.Right} className="repeat-group-handle" />
    </div>
  );
}

export const PREVIEW_FLOW_NODE_TYPES = {
  custom: memo(PreviewCustomNode),
  repeatGroup: memo(PreviewRepeatGroupNode),
};
