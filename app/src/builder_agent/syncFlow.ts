import type { Edge, Node } from "@xyflow/react";
import { BUILDER_NODE_ROW_Y } from "../lib/builderLayout";
import {
  connectFlowNodes,
  createBlockNodeForType,
  createFlowFromParsed,
  createRecurringFlowFromParsed,
  createScheduleNode,
  getDesiredFlowSegments,
  isScheduleControlNode,
  type FlowSegment,
} from "./createNodes";
import type { ParsedPrompt } from "./types";
import { updateFlowNodes } from "./updateFlow";

function findNodeForSegment(nodes: Node[], segment: FlowSegment): Node | undefined {
  if (segment === "schedule") {
    return nodes.find(isScheduleControlNode);
  }
  return nodes.find((node) => node.data.type === segment);
}

function createNodeForSegment(
  segment: FlowSegment,
  parsed: ParsedPrompt,
  position: { x: number; y: number },
  runId: string
): Node {
  if (segment === "schedule") {
    return createScheduleNode(parsed, position, `schedule-${runId}`);
  }
  return createBlockNodeForType(segment, parsed, position, `${runId}-${segment}`);
}

export function syncFlowStructure(
  nodes: Node[],
  _edges: Edge[],
  parsed: ParsedPrompt
): { nodes: Node[]; edges: Edge[] } {
  if (parsed.useLoop) {
    return createRecurringFlowFromParsed(parsed);
  }
  // PIPELINE hops need distinct per-hop node data — rebuild rather than reuse one lend/swap.
  if (parsed.pipelineHops && parsed.pipelineHops.length >= 2) {
    return createFlowFromParsed(parsed);
  }

  const segments = getDesiredFlowSegments(parsed);
  const baseY = nodes[0]?.position.y ?? BUILDER_NODE_ROW_Y;
  const runId = String(Date.now());

  const ordered: Node[] = segments.map((segment, index) => {
    const position = { x: 120 + index * 280, y: baseY };
    const existing = findNodeForSegment(nodes, segment);

    if (existing) {
      return { ...existing, position };
    }

    return createNodeForSegment(segment, parsed, position, runId);
  });

  const updatedNodes = updateFlowNodes(ordered, parsed);
  return {
    nodes: updatedNodes,
    edges: connectFlowNodes(updatedNodes),
  };
}
