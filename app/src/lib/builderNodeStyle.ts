import type { Node } from "@xyflow/react";
import { isRepeatGroupNode } from "./repeatGraph";

/** React Flow applies `node.style` on the outer wrapper; visual chrome belongs on `.custom-node` only. */
export function stripNodeWrapperStyle(node: Node): Node {
  if (isRepeatGroupNode(node)) return node;
  if (!node.style) return node;
  const { style: _style, ...rest } = node;
  return rest as Node;
}
