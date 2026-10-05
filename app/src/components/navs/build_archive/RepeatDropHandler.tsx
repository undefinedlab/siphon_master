"use client";

import { useCallback } from "react";
import { type Node, type OnNodeDrag, useReactFlow } from "@xyflow/react";
import {
  canNestInsideRepeat,
  getAbsoluteNodePosition,
  isRepeatGroupNode,
  positionInsideRepeatBody,
} from "../../../lib/repeatGraph";

export function useRepeatDropHandlers(
  setNodes: (nodes: Node[] | ((nodes: Node[]) => Node[])) => void,
  syncRepeatChildCounts: (nodes: Node[]) => Node[]
) {
  const { getIntersectingNodes } = useReactFlow();

  const onNodeDragStop: OnNodeDrag<Node> = useCallback(
    (_event, draggedNode) => {
      if (!canNestInsideRepeat(draggedNode)) return;

      const intersections = getIntersectingNodes(draggedNode).filter(isRepeatGroupNode);
      const targetRepeat = intersections[0];

      setNodes((nds) => {
        const current = nds.find((n) => n.id === draggedNode.id);
        if (!current) return nds;

        if (targetRepeat && current.parentId !== targetRepeat.id) {
          const absolute = getAbsoluteNodePosition(current, nds);
          const relative = positionInsideRepeatBody(absolute, targetRepeat);
          return syncRepeatChildCounts(
            nds.map((n) =>
              n.id === current.id
                ? {
                    ...n,
                    parentId: targetRepeat.id,
                    extent: "parent" as const,
                    position: relative,
                    zIndex: 10,
                    data: { ...n.data, dragHighlight: false },
                  }
                : isRepeatGroupNode(n)
                  ? { ...n, data: { ...n.data, dragHighlight: false } }
                  : n
            )
          );
        }

        if (!targetRepeat && current.parentId) {
          return syncRepeatChildCounts(
            nds.map((n) =>
              n.id === current.id
                ? {
                    ...n,
                    parentId: undefined,
                    extent: undefined,
                    position: getAbsoluteNodePosition(current, nds),
                    zIndex: 0,
                  }
                : n
            )
          );
        }

        return syncRepeatChildCounts(
          nds.map((n) =>
            isRepeatGroupNode(n) ? { ...n, data: { ...n.data, dragHighlight: false } } : n
          )
        );
      });
    },
    [getIntersectingNodes, setNodes, syncRepeatChildCounts]
  );

  const onNodeDrag: OnNodeDrag<Node> = useCallback(
    (_event, draggedNode) => {
      if (!canNestInsideRepeat(draggedNode)) return;

      const intersections = getIntersectingNodes(draggedNode).filter(isRepeatGroupNode);
      const hoverId = intersections[0]?.id ?? null;

      setNodes((nds) =>
        nds.map((n) => {
          if (!isRepeatGroupNode(n)) return n;
          const highlight = n.id === hoverId;
          if (n.data?.dragHighlight === highlight) return n;
          return { ...n, data: { ...n.data, dragHighlight: highlight } };
        })
      );
    },
    [getIntersectingNodes, setNodes]
  );

  return { onNodeDrag, onNodeDragStop };
}
