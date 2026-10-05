import type { Connection, Edge, Node } from "@xyflow/react";

export type AmountSource = "fixed" | "output";

export function isSwapToWithdrawConnection(
  nodes: Node[],
  connection: Pick<Connection, "source" | "target">
): boolean {
  const source = nodes.find((n) => n.id === connection.source);
  const target = nodes.find((n) => n.id === connection.target);
  return source?.data?.type === "swap" && target?.data?.type === "withdraw";
}

export function applySwapToWithdrawLink(nodes: Node[], connection: Connection): Node[] {
  if (!connection.source || !connection.target) return nodes;
  if (!isSwapToWithdrawConnection(nodes, connection)) return nodes;

  const source = nodes.find((n) => n.id === connection.source)!;
  return nodes.map((node) => {
    if (node.id !== connection.target) return node;
    return {
      ...node,
      data: {
        ...node.data,
        amountSource: "output" as AmountSource,
        linkedFromNodeId: source.id,
        coin: (source.data.toCoin as string) || node.data.coin,
        amount: "",
      },
    };
  });
}

export function clearOutputLinksForRemovedEdges(nodes: Node[], removed: Edge[]): Node[] {
  if (removed.length === 0) return nodes;
  const removedPairs = new Set(removed.map((e) => `${e.source}->${e.target}`));

  return nodes.map((node) => {
    if (node.data?.type !== "withdraw" || node.data?.amountSource !== "output") return node;
    const linkedFrom = String(node.data.linkedFromNodeId || "");
    const pair = `${linkedFrom}->${node.id}`;
    if (!removedPairs.has(pair)) return node;
    return {
      ...node,
      data: {
        ...node.data,
        amountSource: "fixed",
        linkedFromNodeId: null,
      },
    };
  });
}

export function syncLinkedWithdrawFromSwap(nodes: Node[], edges: Edge[], swapNodeId: string): Node[] {
  const swap = nodes.find((n) => n.id === swapNodeId);
  if (!swap || swap.data?.type !== "swap") return nodes;

  const linkedWithdrawIds = new Set(
    edges.filter((e) => e.source === swapNodeId).map((e) => e.target)
  );

  return nodes.map((node) => {
    if (node.data?.type !== "withdraw" || node.data?.amountSource !== "output") return node;
    if (!linkedWithdrawIds.has(node.id)) return node;
    return {
      ...node,
      data: {
        ...node.data,
        linkedFromNodeId: swapNodeId,
        coin: (swap.data.toCoin as string) || node.data.coin,
      },
    };
  });
}

export function resolveWithdrawAmount(
  withdrawNode: Node,
  nodes: Node[],
  edges: Edge[]
): number | undefined {
  const sourceKind = withdrawNode.data?.amountSource as AmountSource | undefined;
  const fixedRaw = String(withdrawNode.data?.amount ?? "").trim();

  if (sourceKind === "output" && !fixedRaw) {
    const edge = edges.find((e) => e.target === withdrawNode.id);
    const source = edge ? nodes.find((n) => n.id === edge.source) : null;
    if (source?.data?.type === "swap") {
      const out = parseFloat(String(source.data.toAmount || ""));
      if (Number.isFinite(out) && out > 0) return out;
      const inp = parseFloat(String(source.data.amount || ""));
      if (Number.isFinite(inp) && inp > 0) return inp;
    }
  }

  const fixed = parseFloat(fixedRaw);
  if (Number.isFinite(fixed) && fixed > 0) return fixed;
  return undefined;
}
