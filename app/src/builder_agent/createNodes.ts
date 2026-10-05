import { Position, type Edge, type Node } from "@xyflow/react";
import { layoutStrategyNodes, BUILDER_NODE_ROW_Y } from "../lib/builderLayout";
import { applySwapToWithdrawLink } from "../lib/graphLinks";
import { getTokenPrices } from "../lib/tokenPrices";
import {
  REPEAT_BODY_OFFSET_X,
  REPEAT_BODY_OFFSET_Y,
  REPEAT_GROUP_DEFAULT_SIZE,
} from "../lib/repeatGraph";
import { defaultSideForKind } from "../lib/strategySpec";
import { applyLimitOrderTreeFields } from "../lib/limitOrderTree";
import { withdrawNodeTitle } from "../lib/bridge/hub";
import type { PipelineHopParsed } from "./pipelineHops";
import type { BlockNodeData, BlockType, ParsedPrompt } from "./types";

function estimateToAmount(amount: string, from: string, to: string): string | null {
  const prices = getTokenPrices();
  const pFrom = prices[from] ?? 0;
  const pTo = prices[to] ?? 0;
  if (!pFrom || !pTo) return null;
  return (parseFloat(amount) * (pFrom / pTo)).toFixed(4);
}

export type FlowSegment = BlockType | "schedule";

export function isScheduleControlNode(node: Node): boolean {
  return (
    node.data?.type === "control" &&
    String(node.data?.controlKind || "").toLowerCase() === "schedule"
  );
}

export function getDesiredBlockTypes(parsed: ParsedPrompt): BlockType[] {
  const types: BlockType[] = ["deposit"];
  if (parsed.includeBridge) types.push("bridge");
  if (parsed.pipelineHops && parsed.pipelineHops.length >= 2) {
    for (const hop of parsed.pipelineHops) {
      types.push(hop.kind === "lend" ? "lend" : "swap");
    }
  } else if (parsed.includeLend) {
    types.push("lend");
  } else {
    types.push("strategy");
    if (parsed.includeSwap) types.push("swap");
  }
  if (parsed.includeWithdraw) types.push("withdraw");
  return types;
}

/** Ordered canvas segments for single-shot flows (non-loop). */
export function getDesiredFlowSegments(parsed: ParsedPrompt): FlowSegment[] {
  const segments: FlowSegment[] = ["deposit"];
  if (parsed.includeSchedule) segments.push("schedule");
  if (parsed.includeBridge) segments.push("bridge");
  if (parsed.pipelineHops && parsed.pipelineHops.length >= 2) {
    for (const hop of parsed.pipelineHops) {
      segments.push(hop.kind === "lend" ? "lend" : "swap");
    }
  } else if (parsed.includeLend) {
    segments.push("lend");
  } else {
    segments.push("strategy");
    if (parsed.includeSwap) segments.push("swap");
  }
  if (parsed.includeWithdraw) segments.push("withdraw");
  return segments;
}

export function createScheduleNode(
  parsed: ParsedPrompt,
  position: { x: number; y: number },
  id: string
): Node {
  return {
    id,
    type: "custom",
    position,
    data: {
      label: "Schedule",
      type: "control",
      controlKind: "schedule",
      scheduleValue: parsed.scheduleValue ?? "1",
      scheduleUnit: parsed.scheduleUnit ?? "hours",
      chain: null,
      dex: null,
      strategy: null,
      coin: null,
      amount: null,
      toCoin: null,
      toAmount: null,
      wallet: null,
      side: null,
      priceGoal: null,
      rangeLow: null,
      rangeHigh: null,
      gridLevels: null,
      sliceCount: null,
      intervalSeconds: null,
      maxSlippageBps: null,
      intervals: null,
    },
    draggable: true,
    selectable: true,
    connectable: true,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  };
}

function swapAmountForParsed(parsed: ParsedPrompt): string | null {
  return parsed.swapAmount ?? parsed.amount;
}

export function buildBlockData(type: BlockType, parsed: ParsedPrompt): BlockNodeData {
  if (type === "deposit") {
    const earnExit = parsed.includeLend && parsed.lendAction === "exit";
    return {
      label: "Deposit",
      type,
      chain: parsed.depositChain,
      dex: null,
      strategy: null,
      coin: earnExit ? "jlUSDC" : parsed.includeLend ? (parsed.coin || "USDC") : parsed.coin,
      amount: parsed.amount,
      toCoin: null,
      toAmount: null,
      wallet: null,
      side: null,
      priceGoal: null,
      rangeLow: null,
      rangeHigh: null,
      gridLevels: null,
      sliceCount: null,
      intervalSeconds: null,
      maxSlippageBps: null,
      intervals: null,
    };
  }

  if (type === "bridge") {
    const from = parsed.depositChain;
    const to = parsed.bridgeToChain ?? parsed.withdrawChain;
    return {
      label: `Bridge → ${to}`,
      type,
      chain: from,
      toChain: to,
      dex: null,
      strategy: null,
      coin: parsed.coin ?? "USDC",
      amount: parsed.amount,
      toCoin: null,
      toAmount: null,
      wallet: null,
      side: null,
      priceGoal: null,
      rangeLow: null,
      rangeHigh: null,
      gridLevels: null,
      sliceCount: null,
      intervalSeconds: null,
      maxSlippageBps: null,
      intervals: null,
    };
  }

  if (type === "strategy") {
    const side = parsed.side ?? defaultSideForKind(parsed.strategy);
    const isPredictions = parsed.strategy === "Predictions";
    const isPerps = parsed.strategy === "Perps";
    const baseData: BlockNodeData = {
      label: isPredictions
        ? `Predictions${parsed.polyOutcome ? ` · ${parsed.polyOutcome}` : ""}`
        : isPerps
          ? `Perps · ${parsed.hlCoin || "BTC"} ${parsed.side === "sell" ? "SHORT" : "LONG"}`
          : parsed.strategy,
      type,
      chain: null,
      dex: null,
      strategy: parsed.strategy,
      side,
      coin: null,
      amount: null,
      toCoin: null,
      toAmount: null,
      wallet: null,
      priceGoal: parsed.priceGoal,
      rangeLow: parsed.rangeLow,
      rangeHigh: parsed.rangeHigh,
      gridLevels: parsed.gridLevels,
      sliceCount: parsed.sliceCount,
      intervalSeconds: parsed.intervalSeconds,
      maxSlippageBps: parsed.maxSlippageBps,
      intervals: parsed.intervals,
    };
    if (isPredictions) {
      baseData.polyTokenId = parsed.polyTokenId;
      baseData.polyMarketId = parsed.polyMarketId;
      baseData.polyOutcome = parsed.polyOutcome;
      baseData.polyMarketQuestion = parsed.polyMarketQuestion;
      baseData.polyOdds = parsed.polyOdds;
      return baseData; // no price-condition tree — the trigger is an odds threshold
    }
    if (isPerps) {
      baseData.hlCoin = parsed.hlCoin || "BTC";
      baseData.hlLeverage = parsed.hlLeverage || "3";
      baseData.hlTakeProfit = parsed.hlTakeProfit;
      baseData.hlStopLoss = parsed.hlStopLoss;
      baseData.coin = "USDC";
      return baseData;
    }
    return applyLimitOrderTreeFields(baseData) as BlockNodeData;
  }

  if (type === "swap") {
    const fromCoin = parsed.coin;
    const toCoin = parsed.toCoin;
    const amount = swapAmountForParsed(parsed);
    const toAmount =
      fromCoin && toCoin && amount ? estimateToAmount(amount, fromCoin, toCoin) : null;

    return {
      label: parsed.dex ? `Swap on ${parsed.dex}` : "Swap",
      type,
      chain: null,
      dex: parsed.dex,
      strategy: null,
      coin: fromCoin,
      amount,
      toCoin,
      toAmount,
      wallet: null,
      side: null,
      priceGoal: null,
      rangeLow: null,
      rangeHigh: null,
      gridLevels: null,
      sliceCount: null,
      intervalSeconds: null,
      maxSlippageBps: null,
      intervals: null,
    };
  }

  if (type === "lend") {
    const action = parsed.lendAction === "exit" ? "exit" : "enter";
    return {
      label: action === "enter" ? "Earn Enter (Jupiter)" : "Earn Exit (Jupiter)",
      type,
      chain: null,
      dex: null,
      strategy: null,
      lendAction: action,
      lendVenue: "jupiter",
      coin: action === "enter" ? "USDC" : "jlUSDC",
      amount: parsed.amount,
      toCoin: action === "enter" ? "jlUSDC" : "USDC",
      toAmount: null,
      wallet: null,
      side: null,
      priceGoal: null,
      rangeLow: null,
      rangeHigh: null,
      gridLevels: null,
      sliceCount: null,
      intervalSeconds: null,
      maxSlippageBps: null,
      intervals: null,
    };
  }

  return {
    label: withdrawNodeTitle(parsed.withdrawChain),
    type,
    chain: parsed.withdrawChain,
    dex: null,
    strategy: null,
    coin: parsed.toCoin ?? parsed.coin,
    amount: parsed.amount,
    toCoin: null,
    toAmount: null,
    wallet: parsed.wallet,
    side: null,
    priceGoal: null,
    rangeLow: null,
    rangeHigh: null,
    gridLevels: null,
    sliceCount: null,
    intervalSeconds: null,
    maxSlippageBps: null,
    intervals: null,
  };
}

export function createBlockNodeForType(
  type: BlockType,
  parsed: ParsedPrompt,
  position: { x: number; y: number },
  idSuffix: string
): Node {
  return {
    id: `${type}-${idSuffix}`,
    type: "custom",
    position,
    data: buildBlockData(type, parsed),
    draggable: true,
    selectable: true,
    connectable: true,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  };
}

export function connectFlowNodes(nodes: Node[]): Edge[] {
  return nodes.slice(0, -1).map((node, index) => {
    const target = nodes[index + 1];
    return {
      id: `edge-${node.id}-${target.id}`,
      source: node.id,
      target: target.id,
      type: "smoothstep",
      style: { stroke: "rgba(255, 255, 255, 0.3)", strokeWidth: 2 },
    };
  });
}

function createSegmentNode(
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

function buildPipelineHopNodeData(hop: PipelineHopParsed, amount: string | null): BlockNodeData {
  if (hop.kind === "lend") {
    const venue = hop.venue === "jito" ? "jito" : "jupiter";
    const action = hop.action === "exit" ? "exit" : "enter";
    if (venue === "jito") {
      return {
        label: action === "enter" ? "Jito Stake" : "Jito Unstake",
        type: "lend",
        chain: null,
        dex: null,
        strategy: null,
        lendAction: action,
        lendVenue: "jito",
        coin: hop.assetIn,
        amount,
        toCoin: hop.assetOut,
        toAmount: null,
        wallet: null,
        side: null,
        priceGoal: null,
        rangeLow: null,
        rangeHigh: null,
        gridLevels: null,
        sliceCount: null,
        intervalSeconds: null,
        maxSlippageBps: null,
        intervals: null,
      };
    }
    return {
      label: action === "enter" ? "Earn Enter (Jupiter)" : "Earn Exit (Jupiter)",
      type: "lend",
      chain: null,
      dex: null,
      strategy: null,
      lendAction: action,
      lendVenue: "jupiter",
      coin: hop.assetIn,
      amount,
      toCoin: hop.assetOut,
      toAmount: null,
      wallet: null,
      side: null,
      priceGoal: null,
      rangeLow: null,
      rangeHigh: null,
      gridLevels: null,
      sliceCount: null,
      intervalSeconds: null,
      maxSlippageBps: null,
      intervals: null,
    };
  }
  return {
    label: `Swap ${hop.assetIn} → ${hop.assetOut}`,
    type: "swap",
    chain: null,
    dex: "Meteora",
    strategy: null,
    coin: hop.assetIn,
    amount,
    toCoin: hop.assetOut,
    toAmount: null,
    wallet: null,
    side: null,
    priceGoal: null,
    rangeLow: null,
    rangeHigh: null,
    gridLevels: null,
    sliceCount: null,
    intervalSeconds: null,
    maxSlippageBps: null,
    intervals: null,
  };
}

/** Deposit → ordered venue hops → optional withdraw (private Solana PIPELINE). */
function createPipelineFlowFromParsed(parsed: ParsedPrompt): { nodes: Node[]; edges: Edge[] } {
  const hops = parsed.pipelineHops!;
  const runId = String(Date.now());
  const nodes: Node[] = [];
  let x = 120;

  const deposit = createBlockNodeForType(
    "deposit",
    { ...parsed, coin: hops[0]?.assetIn || parsed.coin || "USDC" },
    { x, y: BUILDER_NODE_ROW_Y },
    `${runId}-deposit`,
  );
  nodes.push(deposit);
  x += 280;

  if (parsed.includeSchedule) {
    nodes.push(createScheduleNode(parsed, { x, y: BUILDER_NODE_ROW_Y }, `schedule-${runId}`));
    x += 280;
  }

  hops.forEach((hop, i) => {
    const type = hop.kind === "lend" ? "lend" : "swap";
    nodes.push({
      id: `${type}-${runId}-hop${i}`,
      type: "custom",
      position: { x, y: BUILDER_NODE_ROW_Y },
      data: buildPipelineHopNodeData(hop, parsed.amount),
      draggable: true,
      selectable: true,
      connectable: true,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });
    x += 280;
  });

  if (parsed.includeWithdraw) {
    nodes.push(
      createBlockNodeForType("withdraw", parsed, { x, y: BUILDER_NODE_ROW_Y }, `${runId}-withdraw`),
    );
  }

  return { nodes, edges: connectFlowNodes(nodes) };
}

export function createFlowFromParsed(parsed: ParsedPrompt): { nodes: Node[]; edges: Edge[] } {
  if (parsed.useLoop) {
    return createRecurringFlowFromParsed(parsed);
  }
  if (parsed.pipelineHops && parsed.pipelineHops.length >= 2) {
    return createPipelineFlowFromParsed(parsed);
  }

  const runId = String(Date.now());
  const segments = getDesiredFlowSegments(parsed);

  const nodes = segments.map((segment, index) =>
    createSegmentNode(segment, parsed, { x: 120 + index * 280, y: BUILDER_NODE_ROW_Y }, runId)
  );

  return { nodes, edges: connectFlowNodes(nodes) };
}

export function createRecurringFlowFromParsed(
  parsed: ParsedPrompt
): { nodes: Node[]; edges: Edge[] } {
  const runId = Date.now();
  const deposit = createBlockNodeForType(
    "deposit",
    parsed,
    { x: 120, y: BUILDER_NODE_ROW_Y },
    `${runId}-deposit`
  );

  const nodes: Node[] = [deposit];
  const edges: Edge[] = [];
  let cursorX = 400;

  if (parsed.includeSchedule) {
    const scheduleId = `schedule-${runId}`;
    const scheduleNode = createScheduleNode(
      parsed,
      { x: cursorX, y: BUILDER_NODE_ROW_Y },
      scheduleId
    );
    nodes.push(scheduleNode);
    edges.push({
      id: `edge-${deposit.id}-${scheduleId}`,
      source: deposit.id,
      target: scheduleId,
      type: "smoothstep",
      style: { stroke: "rgba(255, 255, 255, 0.3)", strokeWidth: 2 },
    });
    cursorX += 280;
  }

  const repeatId = `repeat-${runId}`;
  const swapId = `swap-${runId}`;
  const withdrawId = `withdraw-${runId}`;

  nodes.push({
    id: repeatId,
    type: "repeatGroup",
    position: { x: cursorX, y: BUILDER_NODE_ROW_Y - 30 },
    data: {
      label: "Loop",
      type: "repeatGroup",
      repeatMode: "until_funds",
      repeatCount: "",
      loopIntervalValue: parsed.loopIntervalValue ?? "24",
      loopIntervalUnit: parsed.loopIntervalUnit ?? "hours",
      childCount: parsed.includeWithdraw ? 2 : 1,
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
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  });

  const prevTop = parsed.includeSchedule ? nodes[nodes.length - 2] : deposit;
  edges.push({
    id: `edge-${prevTop.id}-${repeatId}`,
    source: prevTop.id,
    target: repeatId,
    type: "smoothstep",
    style: { stroke: "rgba(147, 197, 253, 0.45)", strokeWidth: 2 },
  });

  const swapNode = createBlockNodeForType(
    "swap",
    parsed,
    { x: REPEAT_BODY_OFFSET_X, y: REPEAT_BODY_OFFSET_Y + 8 },
    `${runId}-swap`
  );
  swapNode.parentId = repeatId;
  swapNode.extent = "parent";
  swapNode.id = swapId;
  nodes.push(swapNode);

  if (parsed.includeWithdraw) {
    const withdrawNode = createBlockNodeForType(
      "withdraw",
      parsed,
      { x: REPEAT_BODY_OFFSET_X + 210, y: REPEAT_BODY_OFFSET_Y + 8 },
      `${runId}-withdraw`
    );
    withdrawNode.parentId = repeatId;
    withdrawNode.extent = "parent";
    withdrawNode.id = withdrawId;
    withdrawNode.data = {
      ...withdrawNode.data,
      amountSource: "output",
      linkedFromNodeId: swapId,
      amount: "",
    };
    nodes.push(withdrawNode);
    edges.push({
      id: `edge-${swapId}-${withdrawId}`,
      source: swapId,
      target: withdrawId,
      type: "smoothstep",
      style: { stroke: "rgba(147, 197, 253, 0.45)", strokeWidth: 2 },
    });
  }

  let laidOut = layoutStrategyNodes(nodes, edges);
  for (const edge of edges) {
    laidOut = applySwapToWithdrawLink(laidOut, {
      source: edge.source,
      target: edge.target,
      sourceHandle: null,
      targetHandle: null,
    });
  }

  return { nodes: laidOut, edges };
}
