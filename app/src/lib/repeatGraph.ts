import type { Edge, Node } from "@xyflow/react";

export type RepeatMode = "count" | "until_funds";

export const REPEAT_GROUP_TYPE = "repeatGroup";

export function isRepeatGroupNode(node: Node): boolean {
  return node.type === REPEAT_GROUP_TYPE || node.data?.type === REPEAT_GROUP_TYPE;
}

export function getRepeatChildren(nodes: Node[], repeatId: string): Node[] {
  return nodes.filter((node) => node.parentId === repeatId);
}

/** Nodes inside a repeat macro, ordered by x position (left → right). */
export function getRepeatBodyNodes(nodes: Node[], repeatId: string): Node[] {
  return getRepeatChildren(nodes, repeatId).sort(
    (a, b) => a.position.x - b.position.x
  );
}

export function getRepeatBodyEdges(nodes: Node[], edges: Edge[], repeatId: string): Edge[] {
  const childIds = new Set(getRepeatChildren(nodes, repeatId).map((n) => n.id));
  return edges.filter((e) => childIds.has(e.source) && childIds.has(e.target));
}

export function resolveRepeatMode(node: Node): RepeatMode {
  const mode = String(node.data?.repeatMode || "until_funds").toLowerCase();
  if (mode === "count") return "count";
  return "until_funds";
}

export function resolveRepeatCount(node: Node): number | undefined {
  const mode = resolveRepeatMode(node);
  if (mode !== "count") return undefined;
  const raw = String(node.data?.repeatCount || "").trim();
  const count = Number(raw);
  if (!Number.isFinite(count) || count <= 0) return undefined;
  return Math.floor(count);
}

export const REPEAT_GROUP_DEFAULT_SIZE = { width: 520, height: 160 };
export const REPEAT_CHILD_ESTIMATE = { width: 200, height: 130 };
export const REPEAT_CONTENT_PADDING = 24;

/** Drop zone inset below the header row. */
export const REPEAT_BODY_OFFSET_X = 16;
export const REPEAT_BODY_OFFSET_Y = 44;

function childDimensions(child: Node): { width: number; height: number } {
  const measured = child.measured;
  const styleMinW = child.style?.minWidth;
  const parsed =
    typeof styleMinW === "number" ? styleMinW : parseInt(String(styleMinW || ""), 10);
  const width =
    measured?.width ??
    (Number.isFinite(parsed) && parsed > 0 ? parsed : REPEAT_CHILD_ESTIMATE.width);
  const height = measured?.height ?? REPEAT_CHILD_ESTIMATE.height;
  return { width, height };
}

/** Minimum size required to fit all nested blocks. */
export function computeRepeatContentBounds(children: Node[]): { width: number; height: number } {
  if (children.length === 0) {
    return { ...REPEAT_GROUP_DEFAULT_SIZE };
  }

  let maxRight = REPEAT_BODY_OFFSET_X;
  let maxBottom = REPEAT_BODY_OFFSET_Y;

  for (const child of children) {
    const { width, height } = childDimensions(child);
    maxRight = Math.max(maxRight, child.position.x + width + REPEAT_CONTENT_PADDING);
    maxBottom = Math.max(maxBottom, child.position.y + height + REPEAT_CONTENT_PADDING);
  }

  return {
    width: Math.max(REPEAT_GROUP_DEFAULT_SIZE.width, maxRight),
    height: Math.max(REPEAT_GROUP_DEFAULT_SIZE.height, maxBottom),
  };
}

export function resolveRepeatSize(
  node: Node,
  children: Node[]
): { width: number; height: number } {
  const auto = computeRepeatContentBounds(children);
  const overrideW = Number(node.data?.sizeOverrideW) || 0;
  const overrideH = Number(node.data?.sizeOverrideH) || 0;
  return {
    width: Math.max(auto.width, overrideW),
    height: Math.max(auto.height, overrideH),
  };
}

export function syncRepeatGroups(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    if (!isRepeatGroupNode(node)) return node;

    const children = getRepeatChildren(nodes, node.id);
    const childCount = children.length;
    const { width, height } = resolveRepeatSize(node, children);
    const currentW = Number(node.style?.width) || 0;
    const currentH = Number(node.style?.height) || 0;

    const dataChanged = node.data?.childCount !== childCount;
    const sizeChanged = currentW !== width || currentH !== height;
    if (!dataChanged && !sizeChanged) return node;

    return {
      ...node,
      data: { ...node.data, childCount },
      style: {
        ...node.style,
        width,
        height,
        padding: 0,
        background: "transparent",
        border: "none",
      },
    };
  });
}

export function getAbsoluteNodePosition(node: Node, nodes: Node[]): { x: number; y: number } {
  if (!node.parentId) return { ...node.position };
  const parent = nodes.find((n) => n.id === node.parentId);
  if (!parent) return { ...node.position };
  const parentAbs = getAbsoluteNodePosition(parent, nodes);
  return {
    x: parentAbs.x + node.position.x,
    y: parentAbs.y + node.position.y,
  };
}

export function canNestInsideRepeat(node: Node): boolean {
  if (isRepeatGroupNode(node)) return false;
  const blockType = node.data?.type as string | undefined;
  return blockType === "swap" || blockType === "strategy" || blockType === "control" || blockType === "withdraw";
}

export function positionInsideRepeatBody(
  absolutePos: { x: number; y: number },
  repeatNode: Node
): { x: number; y: number } {
  const height = Number(repeatNode.style?.height) || REPEAT_GROUP_DEFAULT_SIZE.height;
  return {
    x: Math.max(REPEAT_BODY_OFFSET_X, absolutePos.x - repeatNode.position.x),
    y: Math.max(
      REPEAT_BODY_OFFSET_Y,
      Math.min(absolutePos.y - repeatNode.position.y, height - 100)
    ),
  };
}

export function createRepeatGroupNode(position?: { x: number; y: number }): Node {
  const id = `repeat-${Date.now()}`;
  return {
    id,
    type: REPEAT_GROUP_TYPE,
    position: position ?? { x: 360, y: 180 },
    data: {
      label: "Loop",
      type: REPEAT_GROUP_TYPE,
      repeatMode: "until_funds",
      repeatCount: "",
      loopIntervalValue: "24",
      loopIntervalUnit: "hours",
    },
    style: {
      width: REPEAT_GROUP_DEFAULT_SIZE.width,
      height: REPEAT_GROUP_DEFAULT_SIZE.height,
      padding: 0,
      background: "transparent",
      border: "none",
    },
    draggable: true,
    selectable: true,
    connectable: true,
  };
}

/** Ensure preview / modal graphs have correct node types and loop metadata. */
export function formatGraphForPreview(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    const isRepeat = isRepeatGroupNode(node);
    return {
      ...node,
      type: isRepeat ? REPEAT_GROUP_TYPE : node.type || "custom",
      data: isRepeat
        ? {
            ...node.data,
            childCount: nodes.filter((n) => n.parentId === node.id).length,
          }
        : node.data,
    };
  });
}
