import type { Edge, Node } from "@xyflow/react";
import { walkTopLevelOrder } from "./builderLayout";
import {
  getRunModeChainLabel,
  getSelectedChainId,
  SOLANA_DEVNET_UI_CHAIN_ID,
} from "./networks";
import { resolveWithdrawAmount } from "./graphLinks";
import {
  getRepeatBodyNodes,
  isRepeatGroupNode,
  resolveRepeatCount,
  resolveRepeatMode,
} from "./repeatGraph";
import {
  buildStrategyPayload,
  computeRangeGridLegs,
  defaultSideForKind,
  inferSideFromSwap,
  normalizeStrategyKind,
  resolveLoopIntervalSeconds,
  resolvePositionPct,
  resolveScheduleStartDelaySeconds,
  validateStrategyFields,
  type StrategyKind,
  type StrategyPayload,
} from "./strategySpec";
import {
  resolveLimitOrderConditionTree,
  validatePriceConditionTreeRaw,
} from "./limitOrderTree";

export type SimStepStatus = "ok" | "warn" | "error" | "pending";

export interface SimulationIssue {
  level: "error" | "warn";
  message: string;
  nodeId?: string;
}

export interface SimulationStep {
  index: number;
  nodeId: string;
  label: string;
  nodeType: string;
  status: SimStepStatus;
  message: string;
  detail?: string;
}

export interface SimulationResult {
  success: boolean;
  steps: SimulationStep[];
  issues: SimulationIssue[];
  summary: string;
  payloadPreview?: StrategyPayload;
  modeLabel?: string;
}

const SOLANA_MAINNET_UI_CHAIN_ID = 900_001;

function isSolanaSimChain(chainId = getSelectedChainId()): boolean {
  return chainId === SOLANA_DEVNET_UI_CHAIN_ID || chainId === SOLANA_MAINNET_UI_CHAIN_ID;
}

// Solana vaults trade SOL ↔ USDC (+ jlUSDC for Jupiter Earn); EVM vaults trade ETH ↔ USDC.
const activeTokens = () =>
  new Set(isSolanaSimChain() ? ["SOL", "USDC", "JLUSDC"] : ["ETH", "USDC"]);

/** Assets the smoke test treats as live on the selected chain (warn otherwise). */
const executableAssets = () =>
  new Set(
    isSolanaSimChain()
      ? ["SOL", "USDC", "JLUSDC"]
      : ["ETH", "USDC", "WBTC", "USDT"],
  );

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const SIM_TOKEN_PRICES_USD: Record<string, number> = {
  ETH: 3000,
  USDC: 1,
  USDT: 1,
  JLUSDC: 1,
  WBTC: 45000,
  SOL: 192,
  XMR: 120,
};

interface SwapLeg {
  from: string;
  to: string;
  fromAmount: number;
  toAmount: number;
}

function isTopLevel(node: Node): boolean {
  return !node.parentId;
}

function nodeLabel(node: Node): string {
  return String(node.data?.label || node.data?.type || node.id);
}

function isScheduleNode(node: Node): boolean {
  return (
    node.data?.type === "control" &&
    String(node.data.controlKind || "").toLowerCase() === "schedule"
  );
}

function isLegacyRepeatNode(node: Node): boolean {
  return (
    node.data?.type === "control" &&
    String(node.data.controlKind || "").toLowerCase() === "repeat" &&
    isTopLevel(node)
  );
}

function isValidWallet(addr: string): boolean {
  if (isSolanaSimChain()) return SOLANA_ADDR_RE.test(addr);
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function addIssue(
  issues: SimulationIssue[],
  level: SimulationIssue["level"],
  message: string,
  nodeId?: string
): void {
  issues.push({ level, message, nodeId });
}

function edgeSetForNodes(nodes: Node[], edges: Edge[]): Set<string> {
  const ids = new Set(nodes.map((n) => n.id));
  return new Set(
    edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => `${e.source}->${e.target}`)
  );
}

function isReachableFrom(
  startId: string,
  targetId: string,
  edges: Edge[],
  allowedIds: Set<string>
): boolean {
  if (startId === targetId) return true;
  const queue = [startId];
  const seen = new Set<string>([startId]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (edge.source !== current || !allowedIds.has(edge.target)) continue;
      if (edge.target === targetId) return true;
      if (!seen.has(edge.target)) {
        seen.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return false;
}

function expandLoopBodySteps(
  repeatNode: Node,
  nodes: Node[],
  edges: Edge[]
): Node[] {
  const body = getRepeatBodyNodes(nodes, repeatNode.id);
  const bodyIds = new Set(body.map((n) => n.id));
  const bodyEdges = edges.filter(
    (e) => bodyIds.has(e.source) && bodyIds.has(e.target)
  );
  const ordered: Node[] = [];
  const seen = new Set<string>();
  const roots = body.filter(
    (n) => !bodyEdges.some((e) => e.target === n.id)
  );
  const queue = [...roots.sort((a, b) => a.position.x - b.position.x)];
  if (queue.length === 0 && body.length > 0) {
    return body;
  }
  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    ordered.push(node);
    bodyEdges
      .filter((e) => e.source === node.id)
      .map((e) => body.find((n) => n.id === e.target)!)
      .filter(Boolean)
      .sort((a, b) => a.position.x - b.position.x)
      .forEach((next) => {
        if (!seen.has(next.id)) queue.push(next);
      });
  }
  for (const node of body) {
    if (!seen.has(node.id)) ordered.push(node);
  }
  return ordered;
}

interface GraphContext {
  depositNode?: Node;
  scheduleNode?: Node;
  repeatGroup?: Node;
  legacyRepeat?: Node;
  loopNodes: Node[];
  strategyNode?: Node;
  swapNode?: Node;
  lendNode?: Node;
  withdrawNode?: Node;
  strategyKind: StrategyKind | null;
  strategyFields: Record<string, string | null | undefined> | null;
  payloadBounds?: StrategyPayload;
  modeLabel: string;
}

function resolveGraphContext(
  nodes: Node[],
  edges: Edge[],
  issues: SimulationIssue[]
): GraphContext | null {
  const depositNode = nodes.find((n) => n.data.type === "deposit" && isTopLevel(n));
  const scheduleNode = nodes.find((n) => isScheduleNode(n) && isTopLevel(n));
  const repeatGroup = nodes.find(isRepeatGroupNode);
  const legacyRepeat = nodes.find(isLegacyRepeatNode);
  const loopNodes = repeatGroup ? getRepeatBodyNodes(nodes, repeatGroup.id) : [];

  const strategyNode =
    loopNodes.find((n) => n.data.type === "strategy") ??
    nodes.find((n) => n.data.type === "strategy" && isTopLevel(n));
  const swapNode =
    loopNodes.find((n) => n.data.type === "swap") ??
    nodes.find((n) => n.data.type === "swap" && isTopLevel(n));
  const lendNode =
    loopNodes.find((n) => n.data.type === "lend") ??
    nodes.find((n) => n.data.type === "lend" && isTopLevel(n));
  const withdrawNode =
    loopNodes.find((n) => n.data.type === "withdraw") ??
    nodes.find((n) => n.data.type === "withdraw" && isTopLevel(n));

  if (!depositNode) {
    addIssue(issues, "error", "Missing Deposit block — every strategy needs a funding source.");
    return null;
  }

  if (!strategyNode && !lendNode && !scheduleNode && !repeatGroup && !legacyRepeat) {
    addIssue(
      issues,
      "error",
      "Add a Strategy trigger, Earn (Jupiter), Schedule, or Loop block to define execution logic."
    );
    return null;
  }

  const strategyKind = strategyNode
    ? normalizeStrategyKind(strategyNode.data.strategy as string)
    : null;

  const resolvedSide =
    strategyKind === "Limit Order" && swapNode
      ? inferSideFromSwap(swapNode.data.coin as string, swapNode.data.toCoin as string)
      : (strategyNode?.data.side as string) ||
        defaultSideForKind(strategyKind ?? "Limit Order");

  const strategyFields = strategyNode
    ? {
        strategy: strategyKind ?? undefined,
        side: resolvedSide,
        priceGoal: strategyNode.data.priceGoal as string,
        positionPct: strategyNode.data.positionPct as string,
        rangeLow: strategyNode.data.rangeLow as string,
        rangeHigh: strategyNode.data.rangeHigh as string,
        gridLevels: strategyNode.data.gridLevels as string,
        sliceCount: strategyNode.data.sliceCount as string,
        intervalSeconds: strategyNode.data.intervalSeconds as string,
        intervals: strategyNode.data.intervals as string,
        maxSlippageBps: strategyNode.data.maxSlippageBps as string,
      }
    : null;

  if (strategyKind && strategyFields) {
    if (strategyKind === "Limit Order") {
      const resolvedTree = resolveLimitOrderConditionTree(
        strategyNode?.data.conditionTree as string | undefined,
        strategyNode?.data.priceGoal as string | undefined,
        strategyNode?.data.side as string | undefined
      );
      const treeValidation = validatePriceConditionTreeRaw(resolvedTree);
      if (!treeValidation.valid) {
        addIssue(
          issues,
          "error",
          treeValidation.error ?? "Limit Order price conditions are incomplete.",
          strategyNode?.id
        );
      }
    } else {
      const validation = validateStrategyFields(strategyKind, strategyFields);
      if (!validation.valid) {
        addIssue(
          issues,
          "error",
          validation.error ?? "Strategy parameters are incomplete.",
          strategyNode?.id
        );
      }
    }
  }

  let payloadBounds: StrategyPayload | undefined;
  let modeLabel = strategyKind ?? "Custom";

  if (strategyKind && strategyFields) {
    payloadBounds = buildStrategyPayload(strategyKind, strategyFields);
  } else if (scheduleNode || repeatGroup || legacyRepeat) {
    const startDelaySec = scheduleNode
      ? resolveScheduleStartDelaySeconds(scheduleNode.data)
      : 0;
    if (scheduleNode && startDelaySec === undefined) {
      addIssue(
        issues,
        "error",
        "Schedule needs a valid start (after X or at HH:MM).",
        scheduleNode.id
      );
    }
    const repeatNode = repeatGroup ?? legacyRepeat;
    const intervalSec = repeatNode
      ? resolveLoopIntervalSeconds(repeatNode.data)
      : undefined;
    if (intervalSec === undefined) {
      addIssue(
        issues,
        "error",
        "Loop block needs a valid cadence (each X time/blocks).",
        repeatNode?.id
      );
    }
    const mode = repeatNode ? resolveRepeatMode(repeatNode) : "until_funds";
    const repeatCount = repeatNode ? resolveRepeatCount(repeatNode) : undefined;
    if (mode === "count" && repeatCount === undefined) {
      addIssue(
        issues,
        "error",
        "Loop set to N times — enter a valid count.",
        repeatNode?.id
      );
    }
    if (repeatGroup && loopNodes.length === 0) {
      addIssue(
        issues,
        "error",
        "Loop container is empty — add blocks inside (right-click Loop → Add inside loop).",
        repeatGroup.id
      );
    }
    if (repeatGroup && !strategyNode && !scheduleNode) {
      const hasSwap = loopNodes.some((n) => n.data.type === "swap");
      if (!hasSwap) {
        addIssue(
          issues,
          "error",
          "Loop needs at least a Swap inside.",
          repeatGroup.id
        );
      }
    }
    const isFiniteRepeat = mode === "count" && repeatCount !== undefined;
    if (intervalSec !== undefined) {
      payloadBounds = {
        strategy_type: isFiniteRepeat ? "TWAP" : "DCA",
        side: "buy",
        upper_bound: 0,
        lower_bound: 0,
        interval_sec: intervalSec,
        start_delay_sec: startDelaySec ?? 0,
        slices: isFiniteRepeat ? repeatCount : undefined,
      };
    }
    modeLabel = strategyKind ?? (scheduleNode ? "Schedule + Loop" : "Loop");
  } else if (lendNode) {
    const action =
      String(lendNode.data.lendAction || "enter").toLowerCase() === "exit" ? "exit" : "enter";
    const jito = String(lendNode.data.lendVenue || "jupiter").toLowerCase() === "jito";
    payloadBounds = {
      strategy_type: jito
        ? action === "exit"
          ? "STAKE_EXIT"
          : "STAKE_ENTER"
        : action === "exit"
          ? "EARN_EXIT"
          : "EARN_ENTER",
      side: "buy",
      upper_bound: 0,
      lower_bound: 0,
    };
    modeLabel = jito
      ? action === "exit"
        ? "Jito Unstake"
        : "Jito Stake"
      : action === "exit"
        ? "Jupiter Earn Exit"
        : "Jupiter Earn Enter";
  }

  return {
    depositNode,
    scheduleNode,
    repeatGroup,
    legacyRepeat,
    loopNodes,
    strategyNode,
    swapNode,
    lendNode,
    withdrawNode,
    strategyKind,
    strategyFields,
    payloadBounds,
    modeLabel,
  };
}

function checkConnectivity(
  nodes: Node[],
  edges: Edge[],
  ctx: GraphContext,
  issues: SimulationIssue[]
): void {
  const depositId = ctx.depositNode!.id;
  const topLevel = nodes.filter(isTopLevel);
  const topIds = new Set(topLevel.map((n) => n.id));

  const execTargets = [
    ctx.strategyNode,
    ctx.swapNode,
    ctx.lendNode,
    ctx.withdrawNode,
    ctx.scheduleNode,
    ctx.repeatGroup,
    ctx.legacyRepeat,
  ].filter((n): n is Node => !!n && isTopLevel(n));

  for (const target of execTargets) {
    if (!isReachableFrom(depositId, target.id, edges, topIds)) {
      addIssue(
        issues,
        "warn",
        `"${nodeLabel(target)}" is not connected to Deposit via edges — execution order may be ambiguous.`,
        target.id
      );
    }
  }

  if (ctx.swapNode && ctx.withdrawNode) {
    const swapId = ctx.swapNode.id;
    const withdrawId = ctx.withdrawNode.id;
    const linked =
      ctx.withdrawNode.data.amountSource === "output" &&
      String(ctx.withdrawNode.data.linkedFromNodeId || "") === swapId;
    const edgeLinked = edges.some(
      (e) => e.source === swapId && e.target === withdrawId
    );
    if (!edgeLinked && !linked) {
      addIssue(
        issues,
        "warn",
        "Swap and Withdraw are not linked — withdraw amount may not follow swap output.",
        ctx.withdrawNode.id
      );
    }
  }

  if (ctx.repeatGroup) {
    const body = expandLoopBodySteps(ctx.repeatGroup, nodes, edges);
    const bodyIds = new Set(body.map((n) => n.id));
    const bodyEdgePairs = edgeSetForNodes(body, edges);
    if (body.length > 1 && bodyEdgePairs.size === 0) {
      addIssue(
        issues,
        "warn",
        "Loop body blocks have no edges between them — using left-to-right order.",
        ctx.repeatGroup.id
      );
    }
    for (const child of body) {
      if (child.parentId !== ctx.repeatGroup.id) continue;
    }
    void bodyIds;
  }

  const connectedIds = new Set<string>();
  const allExecIds = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    if (allExecIds.has(edge.source) && allExecIds.has(edge.target)) {
      connectedIds.add(edge.source);
      connectedIds.add(edge.target);
    }
  }
  for (const node of nodes) {
    if (isRepeatGroupNode(node)) continue;
    if (node.data?.type === "control" && isTopLevel(node)) continue;
    if (!connectedIds.has(node.id) && nodes.length > 1) {
      addIssue(
        issues,
        "warn",
        `"${nodeLabel(node)}" has no edge connections.`,
        node.id
      );
    }
  }
}

function validateDeposit(node: Node, issues: SimulationIssue[]): number | null {
  const coin = String(node.data.coin || "").toUpperCase();
  const amountRaw = String(node.data.amount || "").trim();
  const amount = parseFloat(amountRaw);

  if (!coin) {
    addIssue(issues, "error", "Deposit needs a coin selected.", node.id);
    return null;
  }
  if (!activeTokens().has(coin)) {
    addIssue(
      issues,
      "error",
      `Deposit coin ${coin} is not active here (use ${[...activeTokens()].join(" or ")}).`,
      node.id
    );
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    addIssue(issues, "error", "Deposit needs a positive amount.", node.id);
    return null;
  }
  return amount;
}

function validateSwap(
  node: Node,
  balance: Map<string, number>,
  issues: SimulationIssue[]
): { from: string; to: string; amount: number } | null {
  const from = String(node.data.coin || "").toUpperCase();
  const to = String(node.data.toCoin || "").toUpperCase();
  const amountRaw = String(node.data.amount || "").trim();
  let amount = parseFloat(amountRaw);

  if (!from || !to) {
    addIssue(issues, "error", "Swap needs From and To tokens.", node.id);
    return null;
  }
  if (from === to) {
    addIssue(issues, "error", "Swap From and To must be different tokens.", node.id);
    return null;
  }
  if (!executableAssets().has(from) || !executableAssets().has(to)) {
    const venue = getRunModeChainLabel(getSelectedChainId());
    addIssue(
      issues,
      "warn",
      `Swap pair ${from}→${to} may not be supported on ${venue}.`,
      node.id,
    );
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    const available = balance.get(from) ?? 0;
    if (available > 0) {
      amount = available;
    } else {
      addIssue(issues, "error", "Swap needs an amount or available deposit balance.", node.id);
      return null;
    }
  }
  const available = balance.get(from) ?? 0;
  if (amount > available) {
    addIssue(
      issues,
      "error",
      `Swap amount ${amount} ${from} exceeds available balance ${available} ${from}.`,
      node.id
    );
    return null;
  }
  return { from, to, amount };
}

function validateLend(
  node: Node,
  balance: Map<string, number>,
  issues: SimulationIssue[]
): { from: string; to: string; amount: number; action: "enter" | "exit" } | null {
  if (!isSolanaSimChain()) {
    addIssue(issues, "error", "Earn / stake is only available on Solana Devnet.", node.id);
    return null;
  }
  const action =
    String(node.data.lendAction || "enter").toLowerCase() === "exit" ? "exit" : "enter";
  const jito = String(node.data.lendVenue || "jupiter").toLowerCase() === "jito";
  const from = (
    String(
      node.data.coin ||
        (jito ? (action === "exit" ? "JitoSOL" : "SOL") : action === "exit" ? "jlUSDC" : "USDC"),
    )
  ).toUpperCase();
  const to = (
    String(
      node.data.toCoin ||
        (jito ? (action === "exit" ? "SOL" : "JitoSOL") : action === "exit" ? "USDC" : "jlUSDC"),
    )
  ).toUpperCase();
  const amountRaw = String(node.data.amount || "").trim();
  let amount = parseFloat(amountRaw);

  if (jito) {
    if (action === "enter" && from !== "SOL" && from !== "WSOL") {
      addIssue(issues, "error", "Jito stake supplies SOL for JitoSOL.", node.id);
      return null;
    }
    if (action === "exit" && from !== "JITOSOL") {
      addIssue(issues, "error", "Jito unstake redeems JitoSOL back to SOL.", node.id);
      return null;
    }
  } else {
    if (action === "enter" && from !== "USDC") {
      addIssue(issues, "error", "Earn Enter supplies USDC for jlUSDC shares.", node.id);
      return null;
    }
    if (action === "exit" && from !== "JLUSDC") {
      addIssue(issues, "error", "Earn Exit redeems jlUSDC back to USDC.", node.id);
      return null;
    }
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    const available = balance.get(from) ?? 0;
    if (available > 0) {
      amount = available;
    } else {
      addIssue(
        issues,
        "error",
        `${jito ? "Stake" : "Earn"} needs an amount or available ${from} deposit balance.`,
        node.id,
      );
      return null;
    }
  }
  const available = balance.get(from) ?? 0;
  if (amount > available) {
    addIssue(
      issues,
      "error",
      `Earn amount ${amount} ${from} exceeds available balance ${available} ${from}.`,
      node.id,
    );
    return null;
  }
  return { from, to, amount, action };
}

function formatSimAmount(amount: number): string {
  if (!Number.isFinite(amount)) return "0";
  const abs = Math.abs(amount);
  if (abs >= 1000) return amount.toFixed(2).replace(/\.?0+$/, "");
  if (abs >= 1) return amount.toFixed(4).replace(/\.?0+$/, "");
  return amount.toFixed(6).replace(/\.?0+$/, "");
}

function convertSwapAmount(from: string, to: string, amount: number): number {
  const pFrom = SIM_TOKEN_PRICES_USD[from] ?? 0;
  const pTo = SIM_TOKEN_PRICES_USD[to] ?? 0;
  if (pFrom <= 0 || pTo <= 0) return amount;
  return (amount * pFrom) / pTo;
}

function formatStepHoldings(
  balance: Map<string, number>,
  lastSwap?: SwapLeg | null
): string {
  const positive = [...balance.entries()].filter(([, amount]) => amount > 0.0000001);

  if (lastSwap) {
    const remain = balance.get(lastSwap.from) ?? 0;
    const swappedLine = `${formatSimAmount(lastSwap.fromAmount)} ${lastSwap.from} → ${formatSimAmount(lastSwap.toAmount)} ${lastSwap.to}`;
    const chunks: string[] = [];

    if (remain > 0.0000001) {
      chunks.push(`${formatSimAmount(remain)} ${lastSwap.from} remaining`);
    }

    if (remain > 0.0000001) {
      chunks.push(swappedLine);
    } else {
      chunks.push(`${swappedLine} (no ${lastSwap.from} left)`);
    }

    for (const [coin, amount] of positive) {
      if (coin !== lastSwap.from && coin !== lastSwap.to) {
        chunks.push(`${formatSimAmount(amount)} ${coin}`);
      }
    }

    return `Current step holdings: ${chunks.join("; ")}`;
  }

  if (positive.length === 0) return "Current step holdings: empty";
  return `Current step holdings: ${positive
    .map(([coin, amount]) => `${formatSimAmount(amount)} ${coin}`)
    .join(", ")}`;
}

function formatBalanceLedger(
  balance: Map<string, number>,
  lastSwap?: SwapLeg | null
): string {
  return formatStepHoldings(balance, lastSwap);
}

function findLinkedSwapNode(
  withdrawNode: Node,
  nodes: Node[],
  edges: Edge[]
): Node | null {
  const linkedId = String(withdrawNode.data?.linkedFromNodeId || "");
  if (linkedId) {
    const linked = nodes.find((n) => n.id === linkedId);
    if (linked?.data?.type === "swap") return linked;
  }
  const edge = edges.find((e) => e.target === withdrawNode.id);
  if (!edge) return null;
  const source = nodes.find((n) => n.id === edge.source);
  return source?.data?.type === "swap" ? source : null;
}

function resolveWithdrawAmountForSim(
  withdrawNode: Node,
  nodes: Node[],
  edges: Edge[],
  balance: Map<string, number>
): number | undefined {
  const fixedRaw = String(withdrawNode.data?.amount ?? "").trim();
  const fixed = parseFloat(fixedRaw);
  if (Number.isFinite(fixed) && fixed > 0) return fixed;

  const linkedSwap = findLinkedSwapNode(withdrawNode, nodes, edges);
  if (withdrawNode.data?.amountSource === "output" && linkedSwap) {
    const toCoin = String(linkedSwap.data?.toCoin || "").toUpperCase();
    const available = balance.get(toCoin) ?? 0;
    if (available > 0) return available;
    const swapAmount = parseFloat(String(linkedSwap.data?.amount || ""));
    if (Number.isFinite(swapAmount) && swapAmount > 0) return swapAmount;
  }

  return resolveWithdrawAmount(withdrawNode, nodes, edges);
}

function validateWithdraw(
  node: Node,
  nodes: Node[],
  edges: Edge[],
  balance: Map<string, number>,
  issues: SimulationIssue[],
  lastSwap?: SwapLeg | null
): { coin: string; amount: number; recipient: string } | null {
  const coin = String(node.data.coin || "").toUpperCase();
  const linkedSwap = findLinkedSwapNode(node, nodes, edges);
  const ledger = formatStepHoldings(balance, lastSwap);

  if (!coin) {
    addIssue(issues, "error", "Withdraw needs a coin.", node.id);
    return null;
  }

  if (linkedSwap) {
    const swapOut = String(linkedSwap.data?.toCoin || "").toUpperCase();
    if (swapOut && coin !== swapOut) {
      addIssue(
        issues,
        "error",
        `Withdraw ${coin} but swap outputs ${swapOut}. ${ledger}.`,
        node.id
      );
      return null;
    }
  }

  const available = balance.get(coin) ?? 0;
  if (available <= 0) {
    addIssue(
      issues,
      "error",
      linkedSwap
        ? `No ${coin} balance to withdraw after swap. ${ledger}.`
        : `No ${coin} balance available. ${ledger}.`,
      node.id
    );
    return null;
  }

  const resolved = resolveWithdrawAmountForSim(node, nodes, edges, balance);
  if (resolved === undefined || resolved <= 0) {
    const source = node.data.amountSource === "output" ? "swap output" : "fixed amount";
    addIssue(
      issues,
      "error",
      `Withdraw could not resolve ${source}. ${ledger}.`,
      node.id
    );
    return null;
  }

  if (resolved > available) {
    addIssue(
      issues,
      "error",
      `Withdraw ${resolved} ${coin} exceeds balance ${available} ${coin}. ${ledger}.`,
      node.id
    );
    return null;
  }

  const recipient = String(node.data.wallet || "").trim();

  if (!recipient) {
    addIssue(issues, "error", "Withdraw needs a recipient wallet address.", node.id);
    return null;
  }
  if (!isValidWallet(recipient)) {
    addIssue(
      issues,
      "error",
      isSolanaSimChain()
        ? "Withdraw wallet must be a valid Solana address (Base58, 32–44 chars)."
        : "Withdraw wallet must be a valid 0x address (42 chars).",
      node.id,
    );
    return null;
  }

  return { coin, amount: resolved, recipient };
}

function applySwapToBalance(
  balance: Map<string, number>,
  from: string,
  to: string,
  amount: number
): SwapLeg {
  const toAmount = convertSwapAmount(from, to, amount);
  balance.set(from, Math.max(0, (balance.get(from) ?? 0) - amount));
  balance.set(to, (balance.get(to) ?? 0) + toAmount);
  return { from, to, fromAmount: amount, toAmount };
}

function applyWithdrawToBalance(
  balance: Map<string, number>,
  coin: string,
  amount: number
): void {
  balance.set(coin, Math.max(0, (balance.get(coin) ?? 0) - amount));
}

function describeStrategyTrigger(
  kind: StrategyKind,
  payload: StrategyPayload,
  fields: Record<string, string | null | undefined> | null
): string {
  if (kind === "Range" && payload.grid_levels) {
    const legs = computeRangeGridLegs(
      payload.lower_bound,
      payload.upper_bound,
      payload.grid_levels
    );
    return `Grid ${payload.lower_bound}–${payload.upper_bound} (${payload.grid_levels} levels, ${legs.length} legs)`;
  }
  if (kind === "TWAP") {
    return `TWAP ${payload.slices} slices every ${payload.interval_sec}s`;
  }
  if (kind === "DCA") {
    return `DCA on interval (scheduler)`;
  }
  const price = fields?.priceGoal ?? (payload.upper_bound || payload.lower_bound);
  if (kind === "Limit Order") {
    return "Limit Order multi-price trigger";
  }
  const pct =
    kind === "Stop Loss" || kind === "Take Profit"
      ? resolvePositionPct(fields ?? {})
      : 100;
  const pctNote = pct < 100 ? `, ${pct}% of position` : "";
  return `${kind} trigger @ $${price}${pctNote}`;
}

function buildExecutionSequence(
  nodes: Node[],
  edges: Edge[],
  _ctx: GraphContext
): Node[] {
  const sequence: Node[] = [];
  const topOrder = walkTopLevelOrder(nodes, edges);

  for (const node of topOrder) {
    if (isScheduleNode(node)) {
      sequence.push(node);
      continue;
    }
    if (isRepeatGroupNode(node)) {
      sequence.push(node);
      sequence.push(...expandLoopBodySteps(node, nodes, edges));
      continue;
    }
    if (isLegacyRepeatNode(node)) {
      sequence.push(node);
      continue;
    }
    if (node.data?.type === "control") continue;
    sequence.push(node);
  }

  const seen = new Set<string>();
  const deduped: Node[] = [];
  for (const node of sequence) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    deduped.push(node);
  }
  return deduped;
}

export function runStrategySimulation(nodes: Node[], edges: Edge[]): SimulationResult {
  const issues: SimulationIssue[] = [];
  const steps: SimulationStep[] = [];

  if (nodes.length === 0) {
    return {
      success: false,
      steps: [],
      issues: [{ level: "error", message: "Canvas is empty — add blocks to smoke test." }],
      summary: "Nothing to smoke test.",
    };
  }

  const ctx = resolveGraphContext(nodes, edges, issues);
  if (!ctx) {
    return {
      success: false,
      steps: [],
      issues,
      summary: "Graph structure is incomplete.",
    };
  }

  checkConnectivity(nodes, edges, ctx, issues);

  const balance = new Map<string, number>();
  let lastSwap: SwapLeg | null = null;
  let stepIndex = 0;

  const pushStep = (
    node: Node,
    status: SimStepStatus,
    message: string,
    detail?: string
  ) => {
    steps.push({
      index: stepIndex++,
      nodeId: node.id,
      label: nodeLabel(node),
      nodeType: String(node.data?.type || "unknown"),
      status,
      message,
      detail,
    });
  };

  const sequence = buildExecutionSequence(nodes, edges, ctx);

  for (const node of sequence) {
    const type = node.data?.type;

    if (isScheduleNode(node)) {
      const delay = resolveScheduleStartDelaySeconds(node.data);
      const ok = delay !== undefined;
      pushStep(
        node,
        ok ? "ok" : "error",
        ok
          ? `Schedule: start in ${delay}s (smoke test skips wait)`
          : "Invalid schedule configuration",
        `After ${node.data.scheduleValue} ${node.data.scheduleUnit}`
      );
      continue;
    }

    if (isRepeatGroupNode(node) || isLegacyRepeatNode(node)) {
      const mode = resolveRepeatMode(node);
      const count = resolveRepeatCount(node);
      const interval = resolveLoopIntervalSeconds(node.data);
      const iterationLabel =
        mode === "count" && count !== undefined
          ? `${count} iterations`
          : "until funds end";
      pushStep(
        node,
        interval !== undefined ? "ok" : "error",
        interval !== undefined
          ? `Loop: ${iterationLabel}, every ${interval}s`
          : "Loop cadence is invalid",
        `Smoke test runs one iteration of the loop body`
      );
      continue;
    }

    if (type === "deposit") {
      const amount = validateDeposit(node, issues);
      const hasErrors = issues.some(
        (i) => i.nodeId === node.id && i.level === "error"
      );
      if (amount !== null) {
        const coin = String(node.data.coin || "").toUpperCase();
        balance.set(coin, (balance.get(coin) ?? 0) + amount);
        pushStep(
          node,
          hasErrors ? "error" : "ok",
          `Funded ${amount} ${coin}`,
          formatStepHoldings(balance)
        );
      } else {
        pushStep(node, "error", "Deposit validation failed");
      }
      continue;
    }

    if (type === "strategy" && ctx.strategyKind && ctx.payloadBounds) {
      const hasErrors = issues.some(
        (i) => i.nodeId === node.id && i.level === "error"
      );
      const trigger = describeStrategyTrigger(
        ctx.strategyKind,
        ctx.payloadBounds,
        ctx.strategyFields
      );
      pushStep(
        node,
        hasErrors ? "error" : "ok",
        hasErrors ? "Strategy parameters invalid" : `Trigger ready: ${trigger}`,
        "Smoke test assumes trigger is met for downstream swap"
      );
      continue;
    }

    if (type === "swap") {
      const swap = validateSwap(node, balance, issues);
      const hasErrors = issues.some(
        (i) => i.nodeId === node.id && i.level === "error"
      );
      if (swap) {
        lastSwap = applySwapToBalance(balance, swap.from, swap.to, swap.amount);
        pushStep(
          node,
          hasErrors ? "error" : "ok",
          `Swap ${swap.amount} ${swap.from} → ${formatSimAmount(lastSwap.toAmount)} ${swap.to}`,
          formatStepHoldings(balance, lastSwap)
        );
      } else {
        pushStep(node, "error", "Swap validation failed");
      }
      continue;
    }

    if (type === "lend") {
      const lend = validateLend(node, balance, issues);
      const hasErrors = issues.some(
        (i) => i.nodeId === node.id && i.level === "error"
      );
      if (lend) {
        // Share price ≈ $1 for smoke; live yield is applied at settlement.
        lastSwap = applySwapToBalance(balance, lend.from, lend.to, lend.amount);
        pushStep(
          node,
          hasErrors ? "error" : "ok",
          lend.from.toUpperCase() === "SOL" || lend.from.toUpperCase() === "JITOSOL"
            ? lend.action === "enter"
              ? `Stake ${lend.amount} SOL → JitoSOL (Jito)`
              : `Unstake ${lend.amount} JitoSOL → SOL (Jito)`
            : lend.action === "enter"
              ? `Earn Enter ${lend.amount} USDC → jlUSDC (Jupiter)`
              : `Earn Exit ${lend.amount} jlUSDC → USDC (Jupiter)`,
          formatStepHoldings(balance, lastSwap)
        );
      } else {
        pushStep(node, "error", "Earn validation failed");
      }
      continue;
    }

    if (type === "withdraw") {
      const withdraw = validateWithdraw(node, nodes, edges, balance, issues, lastSwap);
      const hasErrors = issues.some(
        (i) => i.nodeId === node.id && i.level === "error"
      );
      if (withdraw) {
        applyWithdrawToBalance(balance, withdraw.coin, withdraw.amount);
        const source =
          node.data.amountSource === "output" ? "from swap output" : "fixed amount";
        pushStep(
          node,
          hasErrors ? "error" : "ok",
          `Withdraw ${withdraw.amount} ${withdraw.coin} → ${withdraw.recipient.slice(0, 6)}…${withdraw.recipient.slice(-4)}`,
          `${source} · ${formatStepHoldings(balance, lastSwap)}`
        );
      } else {
        const nodeIssue = issues.find((i) => i.nodeId === node.id && i.level === "error");
        pushStep(node, "error", nodeIssue?.message ?? "Withdraw validation failed");
      }
      continue;
    }
  }

  if (!ctx.withdrawNode) {
    addIssue(
      issues,
      "warn",
      "No Withdraw block — funds would remain in the strategy wallet."
    );
  }

  if (!ctx.swapNode && !ctx.lendNode && !ctx.repeatGroup?.id) {
    const hasSwapInLoop = ctx.loopNodes.some((n) => n.data.type === "swap");
    const hasLendInLoop = ctx.loopNodes.some((n) => n.data.type === "lend");
    if (!hasSwapInLoop && !hasLendInLoop) {
      addIssue(issues, "warn", "No Swap or Earn block — nothing converts deposited assets.");
    }
  }

  const hasErrors = issues.some((i) => i.level === "error");
  const hasWarnings = issues.some((i) => i.level === "warn");
  const errorCount = issues.filter((i) => i.level === "error").length;
  const warnCount = issues.filter((i) => i.level === "warn").length;

  let summary: string;
  if (hasErrors) {
    summary = `Smoke test failed — ${errorCount} error${errorCount !== 1 ? "s" : ""}${warnCount ? `, ${warnCount} warning${warnCount !== 1 ? "s" : ""}` : ""}.`;
  } else if (hasWarnings) {
    summary = `Smoke test passed with ${warnCount} warning${warnCount !== 1 ? "s" : ""} — review before running live.`;
  } else {
    summary = `Smoke test passed — ${steps.length} step${steps.length !== 1 ? "s" : ""} look executable end-to-end.`;
  }

  return {
    success: !hasErrors,
    steps,
    issues,
    summary,
    payloadPreview: ctx.payloadBounds,
    modeLabel: ctx.modeLabel,
  };
}
