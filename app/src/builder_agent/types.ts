import type { Edge, Node } from "@xyflow/react";
import type { StrategyKind, StrategySide } from "../lib/strategySpec";
import type { PipelineHopParsed } from "./pipelineHops";

export type { StrategyKind, StrategySide };
export type { PipelineHopParsed };

export type BlockType = "deposit" | "bridge" | "strategy" | "swap" | "lend" | "withdraw";

export interface ParsedPrompt {
  raw: string;
  strategy: StrategyKind;
  side: StrategySide | null;
  depositChain: string;
  withdrawChain: string;
  /** Vault bridge destination label (Arbitrum / Base / Solana). */
  bridgeToChain: string | null;
  /** Swap venue (Uniswap / Meteora / …). Null until chosen when multiple active venues exist. */
  dex: string | null;
  coin: string | null;
  toCoin: string | null;
  amount: string | null;
  /** Per-iteration swap size in loop flows; deposit uses `amount`. */
  swapAmount: string | null;
  priceGoal: string | null;
  rangeLow: string | null;
  rangeHigh: string | null;
  gridLevels: string | null;
  sliceCount: string | null;
  intervalSeconds: string | null;
  maxSlippageBps: string | null;
  intervals: string | null;
  wallet: string | null;
  includeSwap: boolean;
  includeWithdraw: boolean;
  /** Insert a Jupiter Earn lend block (enter / exit). Solana Devnet. */
  includeLend: boolean;
  /** Earn action when includeLend — enter (USDC→jlUSDC) or exit (jlUSDC→USDC). */
  lendAction: "enter" | "exit" | null;
  /**
   * Sequential Solana venue hops (Earn / Meteora / Jito) as one private PIPELINE.
   * When length ≥ 2, the canvas is Deposit → hop nodes (no Strategy), armed via TEE prove-after-hop.
   */
  pipelineHops: PipelineHopParsed[] | null;
  /** Insert a Bridge block after deposit (vault→vault). */
  includeBridge: boolean;
  useLoop: boolean;
  loopIntervalValue: string | null;
  loopIntervalUnit: string | null;
  includeSchedule: boolean;
  scheduleValue: string | null;
  scheduleUnit: string | null;
  /** Predictions (Polymarket): user's market description as extracted by the LLM. */
  polyMarketQuery: string | null;
  /** Predictions: outcome to back (e.g. "Yes", "No", "Chiefs"). */
  polyOutcome: string | null;
  // Resolved via /api/polymarket/events?q= — null until the resolution step matches a market.
  polyTokenId: string | null;
  polyMarketId: string | null;
  polyMarketQuestion: string | null;
  polyOdds: string | null;
  polyOutcomes: string[] | null;
  /** Perps (Hyperliquid): coin e.g. BTC. */
  hlCoin: string | null;
  hlLeverage: string | null;
  hlTakeProfit: string | null;
  hlStopLoss: string | null;
}

export interface BuilderAgentResult {
  nodes: Node[];
  edges: Edge[];
  warnings: string[];
  summary: string;
}

export type MissingField =
  | "coin"
  | "inactiveToken"
  | "amount"
  | "side"
  | "priceGoal"
  | "rangeLow"
  | "rangeHigh"
  | "gridLevels"
  | "sliceCount"
  | "intervalSeconds"
  | "loopInterval"
  | "toCoin"
  | "dex"
  | "wallet"
  | "polyMarket"
  | "polyOutcome"
  | "hlCoin";

export interface BuilderAgentSession {
  parsed: ParsedPrompt;
  pendingField: MissingField | null;
  transcript: string[];
}

export interface BuilderAgentTurnResult {
  nodes: Node[];
  edges: Edge[];
  session: BuilderAgentSession;
  botMessage: string | null;
}

export interface BlockNodeData {
  label: string;
  type: BlockType;
  chain: string | null;
  /** Bridge destination vault label (when type === "bridge"). */
  toChain?: string | null;
  dex: string | null;
  strategy: string | null;
  side: string | null;
  /** Jupiter Earn: enter | exit (when type === "lend"). */
  lendAction?: "enter" | "exit" | null;
  /** jupiter = Earn, jito = liquid stake (when type === "lend"). */
  lendVenue?: "jupiter" | "jito" | null;
  coin: string | null;
  amount: string | null;
  toCoin: string | null;
  toAmount: string | null;
  wallet: string | null;
  priceGoal: string | null;
  rangeLow: string | null;
  rangeHigh: string | null;
  gridLevels: string | null;
  sliceCount: string | null;
  intervalSeconds: string | null;
  maxSlippageBps: string | null;
  intervals: string | null;
  // Predictions (Polymarket) — present only on Predictions strategy nodes.
  polyTokenId?: string | null;
  polyMarketId?: string | null;
  polyOutcome?: string | null;
  polyMarketQuestion?: string | null;
  polyOdds?: string | null;
  // Perps (Hyperliquid)
  hlCoin?: string | null;
  hlLeverage?: string | null;
  hlTakeProfit?: string | null;
  hlStopLoss?: string | null;
  [key: string]: unknown;
}
