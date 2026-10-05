import type { Edge, Node } from "@xyflow/react";
import {
  buildStrategyPayload,
  defaultSideForKind,
  inferSideFromSwap,
  normalizeStrategyKind,
  resolveLoopIntervalSeconds,
  resolveScheduleStartDelaySeconds,
  validateStrategyFields,
  type StrategyKind,
  type StrategyPayload,
} from "./strategySpec";
import {
  getRepeatBodyNodes,
  isRepeatGroupNode,
} from "./repeatGraph";
import { resolveLimitOrderConditionTree, validatePriceConditionTreeRaw } from "./limitOrderTree";
import { pipelinePathSummary } from "../builder_agent/pipelineHops";

export interface GraphRunPlan {
  assetIn: string;
  assetOut: string;
  amount: number;
  recipient: string;
  payload: StrategyPayload;
  startDelaySec: number;
  isScheduled: boolean;
}

function isTopLevel(node: Node): boolean {
  return !node.parentId;
}

function isScheduleNode(node: Node): boolean {
  return node.data?.type === "control" && node.data?.controlKind === "schedule";
}

function fieldValue(
  nodes: Node[],
  runModeValues: Record<string, Record<string, string>>,
  node: Node | undefined,
  field: string,
  fallback = ""
): string {
  if (!node) return fallback;
  const override = runModeValues[node.id]?.[field];
  if (override != null && String(override).trim() !== "") return override;
  if (field === "tokenA") return String(node.data?.coin ?? fallback);
  if (field === "coinB") return String(node.data?.toCoin ?? fallback);
  if (field === "address") return String(node.data?.wallet ?? fallback);
  const raw = node.data?.[field];
  return raw != null ? String(raw) : fallback;
}

function mergeNodeFields(
  nodes: Node[],
  runModeValues: Record<string, Record<string, string>>,
  node: Node | undefined
): Record<string, string> {
  if (!node) return {};
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.data)) {
    if (value != null) merged[key] = String(value);
  }
  const overrides = runModeValues[node.id];
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value.trim()) merged[key] = value;
    }
  }
  return merged;
}

/** Validate canvas + run-mode overrides and build the execution payload bounds. */
export function buildGraphRunPlan(
  nodes: Node[],
  _edges: Edge[],
  runModeValues: Record<string, Record<string, string>>
): { ok: true; plan: GraphRunPlan } | { ok: false; error: string } {
  const depositNode = nodes.find((n) => n.data.type === "deposit" && isTopLevel(n));
  const scheduleNode = nodes.find((n) => isScheduleNode(n) && isTopLevel(n));
  const repeatGroup = nodes.find(isRepeatGroupNode);
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
    return { ok: false, error: "Missing Deposit block." };
  }

  const amountStr = fieldValue(nodes, runModeValues, depositNode, "amount", "0");
  const amount = parseFloat(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Please enter a valid deposit amount." };
  }

  const lendAction =
    fieldValue(nodes, runModeValues, lendNode, "lendAction", "enter").toLowerCase() === "exit"
      ? "exit"
      : "enter";
  const lendVenue =
    fieldValue(nodes, runModeValues, lendNode, "lendVenue", "jupiter").toLowerCase() === "jito"
      ? "jito"
      : "jupiter";
  // Multi-hop PIPELINE: deposit asset → final hop output (not the first lend's jlUSDC/SOL).
  const pipePath = pipelinePathSummary(nodes);
  const assetIn = pipePath
    ? pipePath.assetIn
    : lendNode
      ? lendVenue === "jito"
        ? lendAction === "exit"
          ? "JitoSOL"
          : "SOL"
        : lendAction === "exit"
          ? "jlUSDC"
          : fieldValue(nodes, runModeValues, depositNode, "tokenA", "USDC") || "USDC"
      : fieldValue(nodes, runModeValues, depositNode, "tokenA", "USDC");
  const assetOut = pipePath
    ? pipePath.assetOut
    : lendNode
      ? lendVenue === "jito"
        ? lendAction === "exit"
          ? "SOL"
          : "JitoSOL"
        : lendAction === "exit"
          ? "USDC"
          : "jlUSDC"
      : fieldValue(nodes, runModeValues, swapNode, "coinB", "ETH") ||
        String(swapNode?.data?.toCoin ?? "ETH");

  // Vault-mode keeps the swap output in the Siphon vault as the user's private note, so an
  // external withdrawal address is no longer required — the caller uses the connected wallet as
  // the note owner. Still surface any address the user did enter.
  const recipient = fieldValue(nodes, runModeValues, withdrawNode, "address");

  const startDelaySec = scheduleNode
    ? resolveScheduleStartDelaySeconds(mergeNodeFields(nodes, runModeValues, scheduleNode)) ?? 0
    : 0;

  let payload: StrategyPayload | undefined;

  if (strategyNode) {
    const strategyKind = normalizeStrategyKind(strategyNode.data.strategy as string);
    const strategyFields = mergeNodeFields(nodes, runModeValues, strategyNode);
    const resolvedSide =
      strategyKind === "Limit Order" && swapNode
        ? inferSideFromSwap(
            fieldValue(nodes, runModeValues, swapNode, "coin", assetIn),
            fieldValue(nodes, runModeValues, swapNode, "coinB", assetOut)
          )
        : (strategyFields.side as "buy" | "sell") || defaultSideForKind(strategyKind);

    // A Limit Order keeps its trigger in condition_tree, not priceGoal — validateStrategyFields
    // checks priceGoal and so would reject EVERY tree-based limit order as "needs a valid trigger
    // price". Validate the tree for that kind (mirrors the canvas RUN path in Build.tsx) and let the
    // block below attach it; validate priceGoal-based fields for all other kinds.
    if (strategyKind !== "Limit Order") {
      const validation = validateStrategyFields(strategyKind, {
        ...strategyFields,
        side: resolvedSide,
      });
      if (!validation.valid) {
        return { ok: false, error: validation.error ?? "Strategy parameters are incomplete." };
      }
    }
    payload = buildStrategyPayload(strategyKind, { ...strategyFields, side: resolvedSide });

    // A Limit Order stores the user's trigger price(s) in the node's condition_tree (the AND/OR
    // price-condition UI), NOT in priceGoal. buildStrategyPayload only reads priceGoal, so without
    // this the tree — and the user's actual target — is dropped and a stale priceGoal default is
    // submitted as upper_bound (the "≥3000 order fired at ~1800" bug). Resolve the tree and send it;
    // the trade-executor evaluates condition_tree in preference to the flat upper/lower bounds.
    if (strategyKind === "Limit Order") {
      const triggerAsset = resolvedSide === "buy" ? assetOut : assetIn;
      const treeJson = resolveLimitOrderConditionTree(
        strategyFields.conditionTree,
        strategyFields.priceGoal,
        resolvedSide,
        triggerAsset,
      );
      const treeCheck = validatePriceConditionTreeRaw(treeJson);
      if (!treeCheck.valid) {
        return { ok: false, error: treeCheck.error ?? "Limit Order needs a valid price condition." };
      }
      payload = { ...payload, upper_bound: 0, lower_bound: 0, condition_tree: JSON.parse(treeJson!) };
    }
  } else if (repeatGroup) {
    const loopFields = mergeNodeFields(nodes, runModeValues, repeatGroup);
    const intervalSec = resolveLoopIntervalSeconds(loopFields);
    if (!intervalSec || intervalSec <= 0) {
      return {
        ok: false,
        error: "Loop needs a valid cadence (e.g. every 24 hours).",
      };
    }
    const mode =
      String(loopFields.repeatMode || "until_funds").toLowerCase() === "count"
        ? "count"
        : "until_funds";
    let repeatCount: number | undefined;
    if (mode === "count") {
      const raw = String(loopFields.repeatCount || "").trim();
      const count = Number(raw);
      repeatCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : undefined;
    }
    if (mode === "count" && repeatCount === undefined) {
      return { ok: false, error: "Loop set to N times — enter a valid count." };
    }
    if (!swapNode) {
      return { ok: false, error: "Loop needs at least a Swap inside." };
    }
    const isFiniteRepeat = mode === "count" && repeatCount !== undefined;
    let slices = repeatCount;
    if (!isFiniteRepeat) {
      // "Until funds end": the pre-split model has no truly open-ended path — N is fixed at arming.
      // Derive N = floor(deposit / per-buy) equal legs, where per-buy is the Swap block's amount. The
      // deposit must fund ≥2 buys, capped at the split circuit's 8 slots. Without this, DCA submitted
      // as a single strategy with slices=undefined and the executor FHE-400'd it forever.
      const SPLIT_MAX_SLICES = 8; // Entrypoint.split() has 8 zero-padded slots
      const perBuy = parseFloat(fieldValue(nodes, runModeValues, swapNode, "amount", ""));
      if (!Number.isFinite(perBuy) || perBuy <= 0) {
        return { ok: false, error: "Set a per-buy amount on the Swap block for an 'until funds end' loop." };
      }
      const n = Math.floor(amount / perBuy);
      if (n < 2) {
        return {
          ok: false,
          error: `Per-buy ${perBuy} must be at most half the ${amount} deposit so it makes ≥2 buys — lower the Swap amount or switch to "N times".`,
        };
      }
      slices = Math.min(n, SPLIT_MAX_SLICES);
    }
    payload = {
      strategy_type: isFiniteRepeat ? "TWAP" : "DCA",
      side: "buy",
      upper_bound: 0,
      lower_bound: 0,
      interval_sec: intervalSec,
      slices,
    };
  } else if (lendNode) {
    payload = {
      strategy_type:
        lendVenue === "jito"
          ? lendAction === "exit"
            ? "STAKE_EXIT"
            : "STAKE_ENTER"
          : lendAction === "exit"
            ? "EARN_EXIT"
            : "EARN_ENTER",
      side: "buy",
      upper_bound: 0,
      lower_bound: 0,
    };
  } else if (scheduleNode) {
    return { ok: false, error: "Schedule-only flows need a Strategy or Loop block after the delay." };
  } else {
    return {
      ok: false,
      error: "Add a Strategy, Lend (Jupiter Earn), or Loop block to define execution.",
    };
  }

  return {
    ok: true,
    plan: {
      assetIn,
      assetOut,
      amount,
      recipient,
      payload: {
        ...payload,
        start_delay_sec: startDelaySec > 0 ? startDelaySec : payload.start_delay_sec,
      },
      startDelaySec,
      isScheduled: payload.strategy_type === "TWAP" || payload.strategy_type === "DCA",
    },
  };
}

export function strategyKindFromNodes(nodes: Node[]): StrategyKind | "Loop" | null {
  const repeatGroup = nodes.find(isRepeatGroupNode);
  const strategyNode = nodes.find((n) => n.data.type === "strategy");
  if (strategyNode) return normalizeStrategyKind(strategyNode.data.strategy as string);
  if (repeatGroup) return "Loop";
  return null;
}
