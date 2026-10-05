"use client";

import { useCallback } from "react";
import { Handle, NodeResizer, Position, useReactFlow } from "@xyflow/react";
import {
  computeRepeatContentBounds,
  getRepeatChildren,
  type RepeatMode,
} from "../../../lib/repeatGraph";
import { type ScheduleUnit } from "../../../lib/strategySpec";
import { simHighlightClass } from "./simHighlight";
import type { SimHighlightStatus } from "./useCanvasSimulation";
import "./RepeatGroupNode.css";

interface RepeatGroupData {
  label?: string;
  repeatMode?: string;
  repeatCount?: string;
  loopIntervalValue?: string;
  loopIntervalUnit?: string;
  childCount?: number;
  dragHighlight?: boolean;
  sizeOverrideW?: number;
  sizeOverrideH?: number;
}

interface RepeatGroupNodeProps {
  id: string;
  data: RepeatGroupData;
  selected?: boolean;
  updateNodeData?: (nodeId: string, field: string, value: string) => void;
  simStatus?: SimHighlightStatus;
  simShaking?: boolean;
  simExiting?: boolean;
}

export function RepeatGroupNode({ id, data, selected, updateNodeData, simStatus, simShaking, simExiting }: RepeatGroupNodeProps) {
  const { setNodes, getNodes } = useReactFlow();
  const rawMode = String(data.repeatMode || "until_funds").toLowerCase();
  const mode: RepeatMode = rawMode === "count" ? "count" : "until_funds";
  const children = getRepeatChildren(getNodes(), id);
  const autoSize = computeRepeatContentBounds(children);
  const loopUnit = (data.loopIntervalUnit as ScheduleUnit) || "hours";

  const handleChange = (field: string, value: string) => {
    updateNodeData?.(id, field, value);
  };

  const applyResize = useCallback(
    (width: number, height: number) => {
      setNodes((nds) => {
        const nested = getRepeatChildren(nds, id);
        const auto = computeRepeatContentBounds(nested);
        const nextW = Math.max(auto.width, width);
        const nextH = Math.max(auto.height, height);
        return nds.map((node) =>
          node.id === id
            ? {
                ...node,
                style: { ...node.style, width: nextW, height: nextH },
                data: {
                  ...node.data,
                  sizeOverrideW: nextW,
                  sizeOverrideH: nextH,
                },
              }
            : node
        );
      });
    },
    [id, setNodes]
  );

  return (
    <>
      <NodeResizer
        isVisible={!!selected}
        minWidth={autoSize.width}
        minHeight={autoSize.height}
        onResize={(_event, { width, height }) => applyResize(width, height)}
        onResizeEnd={(_event, { width, height }) => applyResize(width, height)}
        lineClassName="repeat-group-resizer-line"
        handleClassName="repeat-group-resizer-handle"
      />
      <div className={`repeat-group-node${data.dragHighlight ? " repeat-group-node--drop-target" : ""} ${simHighlightClass(simStatus, simShaking, simExiting)}`}>
        <Handle type="target" position={Position.Left} className="repeat-group-handle" />

        <div className="repeat-group-header">
          <span className="repeat-group-title">Loop</span>
          <select
            className="repeat-group-select repeat-group-select--mode"
            value={mode}
            onChange={(e) => handleChange("repeatMode", e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.stopPropagation()}
          >
            <option value="count">N times</option>
            <option value="until_funds">Until funds end</option>
          </select>
          {mode === "count" && (
            <input
              type="text"
              className="repeat-group-input repeat-group-input--count"
              placeholder="Times"
              value={data.repeatCount || ""}
              onChange={(e) => handleChange("repeatCount", e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              onFocus={(e) => e.stopPropagation()}
            />
          )}
          <span className="repeat-group-each-label">Each</span>
          <input
            type="text"
            inputMode="numeric"
            className="repeat-group-input repeat-group-input--interval"
            placeholder="1"
            value={data.loopIntervalValue || ""}
            onChange={(e) => handleChange("loopIntervalValue", e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.stopPropagation()}
          />
          <select
            className="repeat-group-select repeat-group-select--unit"
            value={loopUnit}
            onChange={(e) => handleChange("loopIntervalUnit", e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.stopPropagation()}
          >
            <option value="blocks">Blocks</option>
            <option value="seconds">Seconds</option>
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
          </select>
          <span className="repeat-group-block-count">
            {data.childCount ? `${data.childCount} block${data.childCount !== 1 ? "s" : ""}` : "0 blocks"}
          </span>
        </div>

        <div className="repeat-group-body">
        </div>

        <Handle type="source" position={Position.Right} className="repeat-group-handle" />
      </div>
    </>
  );
}
