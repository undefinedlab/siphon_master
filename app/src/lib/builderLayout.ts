import type { Edge, Node } from "@xyflow/react";
import {
  isRepeatGroupNode,
  REPEAT_BODY_OFFSET_X,
  REPEAT_BODY_OFFSET_Y,
  REPEAT_GROUP_DEFAULT_SIZE,
  syncRepeatGroups,
} from "./repeatGraph";

const NODE_WIDTH = 220;
const TOP_LEVEL_GAP = 56;
const CHILD_GAP = 40;
export const BUILDER_NODE_START_X = 100;
export const BUILDER_NODE_ROW_Y = 480;
const ROW_Y = BUILDER_NODE_ROW_Y;

/** Spread new top-level blocks along the lower canvas band. */
export function randomBuilderNodePosition(): { x: number; y: number } {
  return {
    x: BUILDER_NODE_START_X + Math.random() * 420,
    y: BUILDER_NODE_ROW_Y + Math.random() * 64 - 16,
  };
}

function topLevelRoots(nodes: Node[], edges: Edge[]): string[] {
  const topIds = new Set(nodes.filter((n) => !n.parentId).map((n) => n.id));
  const hasIncoming = new Set(
    edges.filter((e) => topIds.has(e.target)).map((e) => e.target)
  );
  return [...topIds].filter((id) => !hasIncoming.has(id));
}

export function walkTopLevelOrder(nodes: Node[], edges: Edge[]): Node[] {
  const top = nodes.filter((n) => !n.parentId);
  const byId = new Map(top.map((n) => [n.id, n]));
  const order: Node[] = [];
  const seen = new Set<string>();
  const queue = topLevelRoots(nodes, edges).map((id) => byId.get(id)!).filter(Boolean);

  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    order.push(node);
    edges
      .filter((e) => e.source === node.id && byId.has(e.target))
      .map((e) => byId.get(e.target)!)
      .forEach((next) => {
        if (!seen.has(next.id)) queue.push(next);
      });
  }

  for (const node of top.sort((a, b) => a.position.x - b.position.x)) {
    if (!seen.has(node.id)) order.push(node);
  }
  return order;
}

function repeatChildWidth(): number {
  return NODE_WIDTH;
}

/** Space library / loaded graphs so blocks do not overlap. */
export function layoutStrategyNodes(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes;

  const positions = new Map<string, { x: number; y: number }>();
  let cursorX = BUILDER_NODE_START_X;

  for (const node of walkTopLevelOrder(nodes, edges)) {
    if (isRepeatGroupNode(node)) {
      const children = nodes
        .filter((n) => n.parentId === node.id)
        .sort((a, b) => a.position.x - b.position.x);
      let childX = REPEAT_BODY_OFFSET_X;
      const childY = REPEAT_BODY_OFFSET_Y + 8;
      for (const child of children) {
        positions.set(child.id, { x: childX, y: childY });
        childX += repeatChildWidth() + CHILD_GAP;
      }
      positions.set(node.id, { x: cursorX, y: node.position.y || ROW_Y });
      const groupWidth = Math.max(
        REPEAT_GROUP_DEFAULT_SIZE.width,
        childX + TOP_LEVEL_GAP
      );
      cursorX += groupWidth + TOP_LEVEL_GAP;
    } else {
      positions.set(node.id, { x: cursorX, y: node.position.y || ROW_Y });
      cursorX += NODE_WIDTH + TOP_LEVEL_GAP;
    }
  }

  const laidOut = nodes.map((node) => {
    const pos = positions.get(node.id);
    return pos ? { ...node, position: pos } : node;
  });

  return syncRepeatGroups(laidOut);
}

/** Ordered steps for modal run/details lists (deposit → loop body → …). */
export function getModalStepNodes(nodes: Node[], edges: Edge[]): Node[] {
  const ordered: Node[] = [];
  for (const node of walkTopLevelOrder(nodes, edges)) {
    if (isRepeatGroupNode(node)) {
      ordered.push(node);
      ordered.push(...nodes.filter((n) => n.parentId === node.id).sort((a, b) => a.position.x - b.position.x));
    } else {
      ordered.push(node);
    }
  }
  return ordered;
}
