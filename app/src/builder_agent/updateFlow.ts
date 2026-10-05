import type { Node } from "@xyflow/react";
import { defaultSideForKind } from "../lib/strategySpec";
import { applyLimitOrderTreeFields } from "../lib/limitOrderTree";
import { getTokenPrices } from "../lib/tokenPrices";
import { withdrawNodeTitle } from "../lib/bridge/hub";
import type { BlockNodeData, BlockType, ParsedPrompt } from "./types";

function estimateToAmount(amount: string, from: string, to: string): string | null {
  const prices = getTokenPrices();
  const pFrom = prices[from] ?? 0;
  const pTo = prices[to] ?? 0;
  if (!pFrom || !pTo) return null;
  return (parseFloat(amount) * (pFrom / pTo)).toFixed(4);
}

export function updateFlowNodes(nodes: Node[], parsed: ParsedPrompt): Node[] {
  return nodes.map((node) => {
    const type = node.data.type as BlockType;
    const data: BlockNodeData = { ...(node.data as BlockNodeData) };

    if (type === "deposit") {
      data.coin = parsed.coin ?? data.coin;
      if (parsed.amount != null) data.amount = parsed.amount;
      data.label = "Deposit";
      data.chain = parsed.depositChain;
    }

    if (type === "bridge") {
      data.chain = parsed.depositChain;
      data.toChain = parsed.bridgeToChain ?? parsed.withdrawChain ?? data.toChain;
      data.coin = parsed.coin ?? data.coin ?? "USDC";
      if (parsed.amount != null) data.amount = parsed.amount;
      data.label = `Bridge → ${data.toChain ?? "vault"}`;
    }

    if (type === "strategy") {
      data.label = parsed.strategy;
      data.strategy = parsed.strategy;
      data.side = parsed.side ?? data.side ?? defaultSideForKind(parsed.strategy);
      data.priceGoal = parsed.priceGoal ?? data.priceGoal;
      data.rangeLow = parsed.rangeLow ?? data.rangeLow;
      data.rangeHigh = parsed.rangeHigh ?? data.rangeHigh;
      data.gridLevels = parsed.gridLevels ?? data.gridLevels;
      data.sliceCount = parsed.sliceCount ?? data.sliceCount;
      data.intervalSeconds = parsed.intervalSeconds ?? data.intervalSeconds;
      data.maxSlippageBps = parsed.maxSlippageBps ?? data.maxSlippageBps;
      data.intervals = parsed.intervals ?? data.intervals;
      if (parsed.strategy === "Predictions") {
        data.label = `Predictions${parsed.polyOutcome ? ` · ${parsed.polyOutcome}` : ""}`;
        data.polyTokenId = parsed.polyTokenId ?? data.polyTokenId;
        data.polyMarketId = parsed.polyMarketId ?? data.polyMarketId;
        data.polyOutcome = parsed.polyOutcome ?? data.polyOutcome;
        data.polyMarketQuestion = parsed.polyMarketQuestion ?? data.polyMarketQuestion;
        data.polyOdds = parsed.polyOdds ?? data.polyOdds;
      } else if (parsed.strategy === "Perps") {
        data.label = `Perps · ${parsed.hlCoin || "BTC"} ${parsed.side === "sell" ? "SHORT" : "LONG"}`;
        data.hlCoin = parsed.hlCoin ?? data.hlCoin;
        data.hlLeverage = parsed.hlLeverage ?? data.hlLeverage;
        data.hlTakeProfit = parsed.hlTakeProfit ?? data.hlTakeProfit;
        data.hlStopLoss = parsed.hlStopLoss ?? data.hlStopLoss;
        data.coin = "USDC";
      } else {
        Object.assign(data, applyLimitOrderTreeFields(data as Record<string, unknown>));
      }
    }

    if (type === "swap") {
      data.coin = parsed.coin ?? data.coin;
      if (parsed.swapAmount != null) {
        data.amount = parsed.swapAmount;
      } else if (!parsed.useLoop && parsed.amount != null) {
        data.amount = parsed.amount;
      }
      data.toCoin = parsed.toCoin ?? data.toCoin;
      data.dex = parsed.dex;
      data.label = parsed.dex ? `Swap on ${parsed.dex}` : "Swap";
      if (data.coin && data.toCoin && data.amount) {
        data.toAmount = estimateToAmount(data.amount, data.coin, data.toCoin);
      }
    }

    if (type === "withdraw") {
      data.coin = parsed.toCoin ?? parsed.coin ?? data.coin;
      data.amount = parsed.amount ?? data.amount;
      data.wallet = parsed.wallet ?? data.wallet;
      data.chain = parsed.withdrawChain;
      data.label = withdrawNodeTitle(parsed.withdrawChain);
    }

    if (
      node.data.type === "control" &&
      String(node.data.controlKind || "").toLowerCase() === "schedule"
    ) {
      data.scheduleValue = parsed.scheduleValue ?? (data.scheduleValue as string | null);
      data.scheduleUnit = parsed.scheduleUnit ?? (data.scheduleUnit as string | null);
    }

    return { ...node, data };
  });
}
