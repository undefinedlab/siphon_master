"use client";

import React, { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import type { Node, Edge } from '@xyflow/react';
import "./Discover.css";
import "./BuilderRunModal.css";
import StrategyPreviewFlow from "../Builder/StrategyPreviewFlow";
import { getModalStepNodes } from "../../../lib/builderLayout";
import { getRunStepFieldValue, buildRunModeValuesFromNodes } from "../../../lib/runModeValues";
import { buildGraphRunPlan } from "../../../lib/graphRunPlan";
import { submitEncryptedStrategy } from "../../../lib/strategySubmit";
import { generateZKData } from "../../../lib/zkHandler";
import { createVaultOutputNote } from "../../../lib/outputNoteResolver";
import { buildTwapLegs, buildGridLegs, submitSplitOnChain, resolveSwapPool, collectArmingFee, depositForSplit, clampSlippageBps, twapEncryptLeg, gridEncryptLeg } from "../../../lib/multiLegBuilder";
import { buildV3Multi, v3StrategiesLive, v3SwapParams } from "../../../lib/v3/strategyOrchestrateV3";
import { createExecutorSubmitV3 } from "../../../lib/v3/executorSubmitV3";
import { bridgeQuote, isValidDestAddress, payoutDestFor, payoutToken, type StrategyPayout } from "../../../lib/bridge/hub";
import { FEE, executionFeeUsd, armingChargeUsd, windowFeeUsd } from "../../../lib/feeModel";
import { getOrCreateClientKey } from "../../../lib/fhe";
import { NATIVE_TOKEN } from "../../../lib/networks";
import { normalizeStrategyKind, resolvePositionPct } from "../../../lib/strategySpec";
import { walletManager } from "../../extensions/walletManager";
import { resolveWalletAddress } from "../../../lib/walletAddress";
import { getSigner } from "../../../lib/nexus";
import { activeTokensForChain, builderChainProfile } from "@/builder_agent/blocks";
import { readStoredHomeChainId } from "@/lib/chains/homeChains";
import { getSelectedChainId, getTokens, getNetwork, RUN_MODE_CHAIN_LABELS, resolveRunModeChainId, getRunModeChainLabel, getRunModeChainDisplayLabel, selectChainAndSwitchWallet, getZkWithdrawRecipient } from "../../../lib/networks";
import ChainToggle from "../../ChainToggle";
import { formatAmount as formatAmountUtil, calculateExchange as calculateExchangeUtil, calculateNetReceiveEstimate, calculatePipelineNetReceiveEstimate, fetchCoinPrices, calculateFixedCost, calculateRunFee, durationToHours } from "./price_utils";
import { pipelinePathSummary } from "@/builder_agent/pipelineHops";
import { DEFAULT_SWAP_SLIPPAGE_PCT } from "@/lib/quickSwapSettings";
import { friendlyTxError } from "@/lib/handler";
import { ethers } from "ethers";

// Execution-window dropdown (value → hours). Only the four priced tiers — matches feeModel WINDOW_TIERS_USD.
// hoursToWindowOption picks the smallest option that still covers a DCA/TWAP schedule span.
const WINDOW_OPTIONS: Array<[string, number, string]> = [
  ["1h", 1, "1 hour"],
  ["1d", 24, "1 day"],
  ["7d", 168, "7 days"],
  ["30d", 720, "30 days"],
];
function hoursToWindowOption(hours: number): string {
  for (const [value, h] of WINDOW_OPTIONS) if (h >= hours) return value;
  return "30d";
}


interface NodeData {
  label?: string;
  type?: 'deposit' | 'swap' | 'lend' | 'withdraw' | 'strategy' | 'repeatGroup' | 'control';
  coin?: string;
  toCoin?: string;
  amount?: string;
  strategy?: string;
  chain?: string;
  lendAction?: string;
  lendVenue?: string;
  [key: string]: string | undefined;
}

interface StepTag {
  label: string;
  field: string;
  options?: string[];
  /** Options present in `options` but not selectable (greyed in the <select>). */
  disabledOptions?: string[];
  // Read-only derived tag (e.g. withdraw asset = swap output). Rendered as a static
  // chip showing `value` instead of an editable control.
  readOnly?: boolean;
  value?: string;
}

// Plain-English one-liner shown under each step so the numbers aren't ambiguous.
// `coin` is the volatile asset the strategy trades (e.g. ETH), derived from the graph.
function getStepHint(nodeData: NodeData, coin: string): string | null {
  switch (nodeData?.type) {
    case 'deposit':
      return 'Funds to spend from your vault — you deposit once; this just selects which balance to use.';
    case 'strategy': {
      switch (nodeData.strategy) {
        case 'Limit Order':
          return `Trigger price in USD for 1 ${coin} (e.g. 1500 = run when 1 ${coin} = $1,500). Direction follows the swap.`;
        case 'Stop Loss':
          return `Runs when 1 ${coin} falls to this USD price.`;
        case 'Take Profit':
          return `Runs when 1 ${coin} rises to this USD price.`;
        case 'Range':
          return `USD price band per 1 ${coin} — runs across this low–high range.`;
        case 'TWAP':
        case 'DCA':
          return 'Splits the order into slices over time.';
        default:
          return `Trigger price in USD for 1 ${coin}.`;
      }
    }
    case 'swap':
      return `The trade executed when the trigger hits (sells/buys via the chosen DEX).`;
    case 'withdraw':
      return 'Swap output stays private in your Siphon vault — withdraw it anytime from your wallet. (Your address = note owner.)';
    default:
      return null;
  }
}

interface StrategyMetadata {
  name: string;
  author: string;
  nodes: number;
  usage: string | number;
  profit: string;
  description: string;
  category: string;
  chains: string[];
  networks: string[];
  isActive?: boolean;
}

interface DetailsModalProps {
  selectedStrategy: StrategyMetadata;
  isOpen: boolean;
  onClose: () => void;
  isRunMode: boolean;
  setIsRunMode: (mode: boolean) => void;
  modalStrategyNodes: Node[];
  modalStrategyEdges: Edge[];
  runModeValues: Record<string, Record<string, string>>;
  setRunModeValues: (values: Record<string, Record<string, string>> | ((prev: Record<string, Record<string, string>>) => Record<string, Record<string, string>>)) => void;
  runDuration: string;
  setRunDuration: (duration: string) => void;
  isFading: boolean;
  setIsFading: (fading: boolean) => void;
  flowKey: number;
  isFlowLoading: boolean;
  runningStrategies?: Map<string, { startTime: number; isRunning: boolean; loop: boolean }>;
  setRunningStrategies?: (strategies: Map<string, { startTime: number; isRunning: boolean; loop: boolean }> | ((prev: Map<string, { startTime: number; isRunning: boolean; loop: boolean }>) => Map<string, { startTime: number; isRunning: boolean; loop: boolean }>)) => void;
  setNodes: (nodes: Node[] | ((nodes: Node[]) => Node[])) => void;
  setEdges: (edges: Edge[] | ((edges: Edge[]) => Edge[])) => void;
  setViewMode: (mode: 'blueprint' | 'run' | 'discover') => void;
  setCurrentFileName: (name: string) => void;
  savedScenes: Array<{ name: string; nodes: Node[]; edges: Edge[] }>;
  setSavedScenes: (scenes: Array<{ name: string; nodes: Node[]; edges: Edge[] }> | ((scenes: Array<{ name: string; nodes: Node[]; edges: Edge[] }>) => Array<{ name: string; nodes: Node[]; edges: Edge[] }>)) => void;
  setShowSuccessNotification: (show: boolean) => void;
  fromBuilder?: boolean;
}

export default function DetailsModal({
  selectedStrategy,
  isOpen,
  onClose,
  isRunMode,
  setIsRunMode,
  modalStrategyNodes,
  modalStrategyEdges,
  runModeValues,
  setRunModeValues,
  runDuration,
  setRunDuration,
  isFading,
  setIsFading,
  flowKey,
  isFlowLoading,
  runningStrategies,
  setRunningStrategies,
  setNodes,
  setEdges,
  setViewMode,
  setCurrentFileName,
  savedScenes,
  setSavedScenes,
  setShowSuccessNotification,
  fromBuilder = false,
}: DetailsModalProps) {
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionLogs, setExecutionLogs] = useState<string[]>([]);
  const [coinPrices, setCoinPrices] = useState<Record<string, number>>({});
  const [pricesLoaded, setPricesLoaded] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' | 'loading' } | null>(null);
  const [isFadingOut, setIsFadingOut] = useState(false);
  const [isWalletConnected, setIsWalletConnected] = useState(false);
  const [activeChainId, setActiveChainId] = useState(getSelectedChainId);
  const [mounted, setMounted] = useState(false);
  const [builderStepsOpen, setBuilderStepsOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.classList.add("strategy-modal-open");
    document.body.style.overflow = "hidden";
    return () => {
      document.body.classList.remove("strategy-modal-open");
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  // Default the execution window to cover a DCA/TWAP's full schedule when the modal opens, so later
  // legs don't expire before their fire-time (a 24h-interval DCA needs a ≥24h window, not the 1h
  // default). Picks the smallest dropdown option ≥ (last-leg fire-time + 1h). Only fires on open, so
  // the user can still override it afterward.
  useEffect(() => {
    if (!isOpen) return;
    try {
      const plan = buildGraphRunPlan(modalStrategyNodes, modalStrategyEdges, runModeValues);
      if (!plan.ok) return;
      const { strategy_type, slices, interval_sec } = plan.plan.payload;
      const s = slices ?? 0;
      const iv = interval_sec ?? 0;
      if (!((strategy_type === 'DCA' || strategy_type === 'TWAP') && s >= 2 && iv > 0)) return;
      const spanHours = ((s - 1) * iv + 3600) / 3600; // last leg fire-time + 1h execution buffer
      setRunDuration(hoursToWindowOption(spanHours));
    } catch { /* leave the default window */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- default once on open, not on every edit
  }, [isOpen, flowKey]);

  // Keep runDuration on one of the four priced tiers (legacy values like "2h" / "24h" get remapped).
  useEffect(() => {
    if (WINDOW_OPTIONS.some(([v]) => v === runDuration)) return;
    setRunDuration(hoursToWindowOption(durationToHours(runDuration)));
  }, [runDuration, setRunDuration]);

  const stepNodes = useMemo(
    () => getModalStepNodes(modalStrategyNodes, modalStrategyEdges),
    [modalStrategyNodes, modalStrategyEdges]
  );

  // The swap output stays in the Siphon vault (private note) unless the withdraw names another
  // chain — then the executor pays it out there, and the step is shown so its address can be edited.
  const displayStepNodes = useMemo(
    () => stepNodes.filter((n) => {
      const d = n.data as NodeData;
      return d.type !== 'withdraw' || !!payoutDestFor(activeChainId, d.chain as string | undefined);
    }),
    [stepNodes, activeChainId]
  );

  // Derive primary asset from strategy nodes for contextual step hints.
  const strategyCoin = useMemo(() => {
    const VOLATILE = ['ETH', 'BTC', 'SOL'];
    const field = (node: Node, f: string): string | undefined => {
      const rm = getRunStepFieldValue(runModeValues, node.id, f, (node.data as NodeData) || {});
      if (rm != null && rm !== '') return String(rm);
      return (node.data as NodeData)?.[f];
    };

    const swap = modalStrategyNodes.find((n) => (n.data as NodeData)?.type === 'swap');
    const deposit = modalStrategyNodes.find((n) => (n.data as NodeData)?.type === 'deposit');
    const candidates = [
      swap && field(swap, 'coinB'),
      swap && field(swap, 'coin'),
      deposit && field(deposit, 'tokenA'),
      deposit && (deposit.data as NodeData)?.coin,
    ].filter(Boolean) as string[];
    return (candidates.find((c) => VOLATILE.includes(c.toUpperCase())) || 'ETH').toUpperCase();
  }, [modalStrategyNodes, runModeValues]);

  const getStepTags = (nodeData: NodeData, isRunModeView: boolean): StepTag[] => {
    const tags: StepTag[] = [];
    if (nodeData?.type === 'deposit') {
      tags.push({ label: 'Chain', field: 'chain', options: isRunModeView ? [...RUN_MODE_CHAIN_LABELS] : undefined });
      tags.push({
        label: 'Token A',
        field: 'tokenA',
        options: isRunModeView
          ? activeChainId === 900_002
            ? ['USDC', 'SOL', 'jlUSDC', 'JitoSOL']
            : ['USDC', 'ETH']
          : undefined,
      });
      tags.push({ label: 'Amount', field: 'amount' });
      return tags;
    }

    if (nodeData?.type === 'strategy') {
      const strategyKind = nodeData.strategy || '';
      if (strategyKind === 'Limit Order') {
        tags.push({ label: 'Goal Price', field: 'priceGoal' });
      } else if (strategyKind === 'Range') {
        tags.push({ label: 'Range Low', field: 'rangeLow' });
        tags.push({ label: 'Range High', field: 'rangeHigh' });
        tags.push({ label: 'Grid Levels', field: 'gridLevels' });
        tags.push({ label: 'Slippage Bps', field: 'maxSlippageBps' });
      } else if (strategyKind === 'TWAP') {
        tags.push({ label: 'Slices', field: 'sliceCount' });
        tags.push({ label: 'Interval Sec', field: 'intervalSeconds' });
        tags.push({ label: 'Slippage Bps', field: 'maxSlippageBps' });
      } else if (strategyKind === 'DCA') {
        // DCA reads `intervals` (a human string like "24 hours" — parseHumanIntervalToSeconds),
        // NOT TWAP's numeric `intervalSeconds`. Without these two rows the node renders no inputs
        // at all and validateStrategyFields rejects every run with "DCA needs an interval schedule".
        tags.push({ label: 'Buys', field: 'sliceCount' });
        tags.push({ label: 'Every', field: 'intervals' });
        tags.push({ label: 'Slippage Bps', field: 'maxSlippageBps' });
      } else if (strategyKind === 'Stop Loss' || strategyKind === 'Take Profit') {
        tags.push({ label: 'PriceGoal', field: 'priceGoal' });
        tags.push({ label: 'Position %', field: 'positionPct' });
      }
      return tags;
    }

    if (nodeData?.type === 'lend') {
      tags.push({
        label: 'Action',
        field: 'lendAction',
        options: isRunModeView ? ['enter', 'exit'] : undefined,
      });
      if (isRunModeView) {
        tags.push({ label: 'Amount', field: 'amount' });
      }
      return tags;
    }

    if (nodeData?.type === 'swap') {
      const chainOpts = {
        chainId: getSelectedChainId(),
        homeChainId: readStoredHomeChainId(),
      };
      const profile = builderChainProfile(chainOpts);
      // Show every venue; inactive ones are disabled in the <select> below.
      const dexOptions = isRunModeView ? [...profile.swapDexes] : undefined;
      const tokenOpts = [...activeTokensForChain(chainOpts)];
      tags.push({
        label: 'Dex',
        field: 'dexType',
        options: dexOptions,
        disabledOptions: isRunModeView
          ? profile.swapDexes.filter((d) => !profile.activeSwapDexes.includes(d))
          : undefined,
      });
      if (isRunModeView) {
        tags.push({ label: 'From', field: 'coin', options: tokenOpts });
        // Only a LOOP reads this — graphRunPlan uses it as the per-buy size for an
        // "until funds end" repeat. Every strategy-node graph takes its size from the Deposit
        // block and ignores whatever is typed here, so showing it there invites the user to set a
        // number that silently does nothing.
        if (modalStrategyNodes.some((n) => (n.data as NodeData)?.type === 'repeatGroup')) {
          tags.push({ label: 'Per-buy Amount', field: 'amount' });
        }
      }
      tags.push({ label: 'To', field: 'coinB', options: isRunModeView ? tokenOpts : undefined });
      return tags;
    }

    if (nodeData?.type === 'withdraw') {
      tags.push({ label: 'Chain', field: 'chain', options: isRunModeView ? [...RUN_MODE_CHAIN_LABELS] : undefined });
      if (isRunModeView) {
        // The withdrawn asset is whatever the swap outputs — not a free choice. Show it
        // read-only (derived from the swap's "To" coin, honouring any run-mode override)
        // instead of a misleading editable dropdown that the execution path ignores.
        const swapNode = modalStrategyNodes.find((n) => (n.data as NodeData)?.type === 'swap');
        const swapOut = swapNode
          ? getRunStepFieldValue(runModeValues, swapNode.id, 'coinB', swapNode.data as NodeData)
          : '';
        tags.push({ label: 'Receive', field: 'coin', readOnly: true, value: swapOut || 'ETH' });
        tags.push({ label: 'Amount', field: 'amount' });
      }
      tags.push({ label: 'Address', field: 'address' });
      return tags;
    }

    if (nodeData?.type === 'repeatGroup') {
      if (!isRunModeView) return tags;
      tags.push({
        label: 'Mode',
        field: 'repeatMode',
        options: ['until_funds', 'count'],
      });
      tags.push({ label: 'Count', field: 'repeatCount' });
      tags.push({ label: 'Every', field: 'loopIntervalValue' });
      tags.push({
        label: 'Unit',
        field: 'loopIntervalUnit',
        options: ['blocks', 'seconds', 'minutes', 'hours'],
      });
      return tags;
    }

    if (nodeData?.type === 'control') {
      const kind = String(nodeData.controlKind || '').toLowerCase();
      if (kind === 'schedule' && isRunModeView) {
        tags.push({ label: 'Value', field: 'scheduleValue' });
        tags.push({
          label: 'Unit',
          field: 'scheduleUnit',
          options: ['blocks', 'seconds', 'minutes', 'hours'],
        });
      }
      return tags;
    }

    return tags;
  };

  // Fetch prices when entering Run mode or opening from the builder
  useEffect(() => {
    if (isOpen && (isRunMode || fromBuilder) && !pricesLoaded) {
      const fetchPrices = async () => {
        try {
          const prices = await fetchCoinPrices();
          if (Object.keys(prices).length > 0) {
            setCoinPrices(prices);
            setPricesLoaded(true);
          } else {
            // Fallback prices
            console.warn('[DetailsModal] Using fallback prices');
            setCoinPrices({
              'ETH': 3000,
              'USDC': 1,
              'SOL': 192,
              'BTC': 45000,
            });
            setPricesLoaded(true);
          }
        } catch (error) {
          console.error('[DetailsModal] Error fetching prices:', error);
          // Fallback prices
          setCoinPrices({
            'ETH': 3000,
            'USDC': 1,
            'SOL': 192,
            'BTC': 45000,
          });
          setPricesLoaded(true);
        }
      };
      fetchPrices();
    }
  }, [isOpen, isRunMode, fromBuilder, pricesLoaded]);

  // Reset prices when modal closes or when exiting Run mode
  useEffect(() => {
    if (!isOpen || !isRunMode) {
      setPricesLoaded(false);
      setCoinPrices({});
    }
  }, [isOpen, isRunMode]);

  // Check wallet connection status
  useEffect(() => {
    const checkWalletConnection = async () => {
      const restored = await walletManager.restorePersistedSession();
      setIsWalletConnected(Boolean(restored ?? walletManager.getPrimaryWallet()));
    };

    void checkWalletConnection();

    const handleWalletConnected = () => {
      setIsWalletConnected(walletManager.hasActiveSession());
    };

    const handleWalletDisconnected = () => {
      setIsWalletConnected(false);
    };

    window.addEventListener('walletConnected', handleWalletConnected);
    window.addEventListener('walletDisconnected', handleWalletDisconnected);

    return () => {
      window.removeEventListener('walletConnected', handleWalletConnected);
      window.removeEventListener('walletDisconnected', handleWalletDisconnected);
    };
  }, [isOpen]);

  useEffect(() => {
    setActiveChainId(getSelectedChainId());
    const onChain = (e: Event) => {
      const id = (e as CustomEvent<{ chainId: number }>).detail?.chainId;
      if (id) setActiveChainId(id);
    };
    window.addEventListener('siphon:chainChanged', onChain);
    return () => window.removeEventListener('siphon:chainChanged', onChain);
  }, [isOpen]);

  // Local wrapper functions that use fetched prices
  const calculateExchange = (inputAmount: number, coinA: string, coinB: string): number => {
    return calculateExchangeUtil(inputAmount, coinA, coinB, coinPrices);
  };

  const estimateSlippagePct = useMemo(() => {
    const strategyNode = modalStrategyNodes.find((n) => (n.data as NodeData)?.type === "strategy");
    if (!strategyNode) return DEFAULT_SWAP_SLIPPAGE_PCT;
    const bps = getRunStepFieldValue(
      runModeValues,
      strategyNode.id,
      "maxSlippageBps",
      strategyNode.data as NodeData,
    );
    const parsed = parseFloat(bps || "");
    return Number.isFinite(parsed) && parsed > 0 ? parsed / 100 : DEFAULT_SWAP_SLIPPAGE_PCT;
  }, [modalStrategyNodes, runModeValues]);

  const formatAmount = (amount: number, coin?: string): string => {
    return formatAmountUtil(amount, coin);
  };

  const executionTime = "4–8"; // Typical arm → fill latency range
  const runDurationHours = durationToHours(runDuration);
  const baseFee = calculateFixedCost();
  const totalCost = calculateRunFee(runDuration);

  const runSummary = useMemo(() => {
    const depositNode = modalStrategyNodes.find((n) => (n.data as NodeData)?.type === "deposit");
    const swapNode = modalStrategyNodes.find((n) => (n.data as NodeData)?.type === "swap");
    const lendNode = modalStrategyNodes.find((n) => (n.data as NodeData)?.type === "lend");
    const depositData = depositNode?.data as NodeData | undefined;
    const swapData = swapNode?.data as NodeData | undefined;
    const lendData = lendNode?.data as NodeData | undefined;
    const depositStepId = depositNode?.id ?? "";
    const swapStepId = swapNode?.id ?? "";
    const lendStepId = lendNode?.id ?? "";
    const pipePath = pipelinePathSummary(modalStrategyNodes);

    const inputCoin =
      pipePath?.assetIn ||
      getRunStepFieldValue(runModeValues, depositStepId, "tokenA", depositData || {}) ||
      depositData?.coin ||
      "USDC";
    const lendOut =
      getRunStepFieldValue(runModeValues, lendStepId, "coinB", lendData || {}) ||
      lendData?.toCoin ||
      "";
    // Prefer final pipeline hop output (e.g. USDC), not the first swap's SOL.
    const outputCoin =
      pipePath?.assetOut ||
      getRunStepFieldValue(runModeValues, swapStepId, "coinB", swapData || {}) ||
      swapData?.toCoin ||
      lendOut ||
      inputCoin;
    const inputAmount =
      parseFloat(getRunStepFieldValue(runModeValues, depositStepId, "amount", depositData || {}) || "0") ||
      0;
    const outputAmount = pipePath
      ? calculatePipelineNetReceiveEstimate(
          inputAmount,
          pipePath.hops,
          coinPrices,
          estimateSlippagePct,
        )
      : calculateNetReceiveEstimate(
          inputAmount,
          inputCoin,
          outputCoin,
          coinPrices,
          estimateSlippagePct,
          totalCost,
        );

    const strategyNode = modalStrategyNodes.find((n) => (n.data as NodeData)?.type === "strategy");
    const lendAction =
      getRunStepFieldValue(runModeValues, lendStepId, "lendAction", lendData || {}).toLowerCase() ===
      "exit"
        ? "exit"
        : "enter";
    const lendVenue =
      getRunStepFieldValue(runModeValues, lendStepId, "lendVenue", lendData || {}).toLowerCase() ===
      "jito"
        ? "jito"
        : "jupiter";
    const strategyKind =
      pipePath
        ? "Pipeline"
        : (strategyNode?.data as NodeData)?.strategy ||
          (lendNode
            ? lendVenue === "jito"
              ? lendAction === "exit"
                ? "Jito Unstake"
                : "Jito Stake"
              : lendAction === "exit"
                ? "Jupiter Earn Exit"
                : "Jupiter Earn Enter"
            : "Custom");
    const priceGoal = strategyNode
      ? getRunStepFieldValue(runModeValues, strategyNode.id, "priceGoal", strategyNode.data as NodeData)
      : "";
    const depositChainRaw = depositNode
      ? getRunStepFieldValue(runModeValues, depositStepId, "chain", depositData || {}) ||
        getRunModeChainLabel(activeChainId)
      : getRunModeChainLabel(activeChainId);
    const depositChain = getRunModeChainDisplayLabel(depositChainRaw);

    const coinPrice = (symbol: string) => {
      const s = symbol.toUpperCase();
      if (s === "USDC" || s === "USDT" || s === "JLUSDC") return coinPrices[s] ?? coinPrices.USDC ?? 1;
      if (s === "JITOSOL") return coinPrices.JITOSOL ?? coinPrices.SOL ?? 0;
      return coinPrices[s] ?? 0;
    };
    const inputUsd = inputAmount * coinPrice(inputCoin);
    const outputUsd = outputAmount * coinPrice(outputCoin);

    return {
      inputCoin,
      outputCoin,
      inputAmount,
      outputAmount,
      inputUsd,
      outputUsd,
      strategyKind,
      pathLabel: pipePath?.pathLabel || "",
      priceGoal,
      depositChain,
      stepCount: displayStepNodes.length,
    };
  }, [modalStrategyNodes, runModeValues, coinPrices, displayStepNodes, activeChainId, estimateSlippagePct, totalCost]);

  // Every order pays ONE upfront USDC transfer: the $0.25 arming fee plus the tier for the
  // execution window it asks for. The fill fee is a flat percentage of notional, no floor.
  const costIsMultiLeg = runSummary.strategyKind === "TWAP" || runSummary.strategyKind === "Range";
  const armingUsd = totalCost;
  const inputCoinUsd = coinPrices[runSummary.inputCoin?.toUpperCase?.() ?? ""] ??
    (["USDC", "USDT"].includes((runSummary.inputCoin || "").toUpperCase()) ? 1 : 0);
  const execFeeUsd = runSummary.inputUsd > 0
    ? Math.min(executionFeeUsd(runSummary.inputUsd), runSummary.inputUsd / 2)
    : 0;

  const formatUsd = (value: number) =>
    value > 0 ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—";

  const renderEditableRunSteps = () => (
    <div className="strategy-steps-list builder-run-steps-list">
      {displayStepNodes.map((node, index) => {
        const nodeData = node.data as NodeData;
        const tags = getStepTags(nodeData, true);
        const stepId = node.id;

        const handleMyWallet = () => {
          const walletAddress = resolveWalletAddress();
          if (walletAddress) {
            setRunModeValues((prev) => ({
              ...prev,
              [stepId]: { ...prev[stepId], address: walletAddress },
            }));
            showToast("Wallet address filled successfully", "success");
          } else {
            showToast("No wallet connected. Please connect a wallet first.", "error");
          }
        };

        return (
          <div key={node.id} className="strategy-step-item builder-run-step-item">
            <div className="strategy-step-number">{index + 1}</div>
            <div className="strategy-step-content">
              <div className="strategy-step-title">{nodeData?.label || `Step ${index + 1}`}</div>
              {getStepHint(nodeData, strategyCoin) && (
                <div className="strategy-step-hint">{getStepHint(nodeData, strategyCoin)}</div>
              )}
              <div className="strategy-step-details">
                {tags.map((tag, idx) => (
                  <div key={idx} className="strategy-step-input-wrapper">
                    {tag.readOnly ? (
                      <div className="strategy-step-readonly" title="Determined by the swap output">
                        <span className="strategy-step-readonly-label">{tag.label}</span>
                        <span className="strategy-step-readonly-value">{tag.value}</span>
                      </div>
                    ) : tag.options ? (
                      <select
                        className="strategy-step-select"
                        value={getRunStepFieldValue(runModeValues, stepId, tag.field, nodeData)}
                        onChange={(e) => {
                          setRunModeValues((prev) => ({
                            ...prev,
                            [stepId]: { ...prev[stepId], [tag.field]: e.target.value },
                          }));
                        }}
                      >
                        <option value="">{tag.label}</option>
                        {tag.field === "repeatMode" ? (
                          <>
                            <option value="until_funds">Until funds end</option>
                            <option value="count">N times</option>
                          </>
                        ) : (
                          tag.options.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))
                        )}
                      </select>
                    ) : (
                      <input
                        type="text"
                        className="strategy-step-input"
                        placeholder={tag.label}
                        value={
                          runModeValues[stepId]?.[tag.field] ??
                          getRunStepFieldValue(runModeValues, stepId, tag.field, nodeData)
                        }
                        onChange={(e) => {
                          setRunModeValues((prev) => ({
                            ...prev,
                            [stepId]: { ...prev[stepId], [tag.field]: e.target.value },
                          }));
                        }}
                      />
                    )}
                  </div>
                ))}
                {nodeData?.type === "withdraw" && (
                  <button
                    className="strategy-step-my-wallet-btn"
                    onClick={handleMyWallet}
                    type="button"
                  >
                    My Wallet
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  const addLog = (message: string) => {
    setExecutionLogs(prev => [...prev, message]);
  };

  // A fresh deposit takes ~2 min to become provable (watcher admit + postman publish on-chain).
  // aspProof waits it out instead of erroring; surface progress so it doesn't look frozen.
  useEffect(() => {
    const onAspWait = (e: Event) => {
      const { waitedMs, timeoutMs, done, ok } =
        (e as CustomEvent<{ waitedMs: number; timeoutMs: number; done?: boolean; ok?: boolean }>).detail;
      const secs = Math.round(waitedMs / 1000);
      const line = done
        ? ok
          ? `Association-set admission confirmed after ${secs}s.`
          : `Association-set admission did not complete within ${Math.round(timeoutMs / 1000)}s.`
        : `Waiting for association-set admission of your deposit… ${secs}s / ${Math.round(
            timeoutMs / 1000,
          )}s`;
      setExecutionLogs(prev =>
        // Replace the previous countdown rather than appending a line every 5s (and clear it on done).
        prev.length && prev[prev.length - 1].startsWith('Waiting for association-set')
          ? [...prev.slice(0, -1), line]
          : [...prev, line],
      );
    };
    window.addEventListener('siphon:aspWait', onAspWait);
    return () => window.removeEventListener('siphon:aspWait', onAspWait);
  }, []);

  const showToast = (message: string, type: 'success' | 'error' | 'info' | 'loading' = 'info') => {
    setIsFadingOut(false);
    setToast({ message, type });
    if (type !== 'loading') {
      setTimeout(() => {
        setIsFadingOut(true);
        setTimeout(() => {
          setToast(null);
          setIsFadingOut(false);
        }, 300); // Match fade out animation duration
      }, 3000);
    }
  };

  // Auto-hide toast after 3 seconds (except loading toasts)
  useEffect(() => {
    if (toast && toast.type !== 'loading') {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  if (!isOpen || !mounted) return null;

  const handleClose = () => {
    setIsRunMode(false);
    setRunModeValues({});
    setBuilderStepsOpen(false);
    onClose();
  };

  /** Close execution summary and let the parent surface the activity-log toast. */
  const finishSuccessfulRun = () => {
    setIsExecuting(false);
    setIsFading(false);
    setExecutionLogs([]);
    setShowSuccessNotification(true);
    setTimeout(() => setShowSuccessNotification(false), 3000);
    handleClose();
  };

  const handleConnectWallet = () => {
    // Trigger the topbar ConnectButton to open wallet selector
    window.dispatchEvent(new CustomEvent('triggerWalletConnection'));
  };

  const handleExecute = async () => {
    // Check wallet connection first
    if (!isWalletConnected) {
      await handleConnectWallet();
      return;
    }

    if (!isRunMode) {
      setIsFading(true);
      setTimeout(() => {
        setIsRunMode(true);
        setRunModeValues(buildRunModeValuesFromNodes(modalStrategyNodes));
        setIsFading(false);
      }, 200);
      return;
    }

    setIsExecuting(true);
    setExecutionLogs([]);
    addLog('Starting strategy execution...');

    const depositNode = modalStrategyNodes.find(n => (n.data as NodeData).type === 'deposit');
    const swapNode = modalStrategyNodes.find(n => (n.data as NodeData).type === 'swap');

    const runPlan = buildGraphRunPlan(modalStrategyNodes, modalStrategyEdges, runModeValues);
    if (!runPlan.ok) {
      showToast(runPlan.error, 'error');
      setIsExecuting(false);
      return;
    }

    const { plan } = runPlan;
    const { assetIn, assetOut, amount, payload: bounds } = plan;

    // Vault-mode: the swap output stays in the Siphon vault as the user's private note — there's
    // no external withdrawal step. The recipient/owner is simply the connected wallet.
    const recipient = walletManager.getConnectedWallets()[0]?.address || plan.recipient || '';
    if (!recipient) {
      showToast('Connect your wallet to run this strategy.', 'error');
      setIsExecuting(false);
      return;
    }

    const getValue = (nodeId: string | undefined, field: string, defaultVal: string = '') => {
      if (!nodeId) return defaultVal;
      if (runModeValues[nodeId] && runModeValues[nodeId][field]) {
        return runModeValues[nodeId][field];
      }
      const node = modalStrategyNodes.find(n => n.id === nodeId);
      return (node?.data as NodeData)?.[field] || defaultVal;
    };

    const amountStr = getValue(depositNode?.id, 'amount', String(amount));

    // Stop Loss / Take Profit can act on a fraction of the deposit (Position %). Apply it to the
    // amount actually withdrawn + swapped; the remainder stays as a shielded change note. Other
    // kinds use the full deposit (positionPct resolves to 100).
    const strategyNode = modalStrategyNodes.find(n => (n.data as NodeData).type === 'strategy');
    const strategyKind = normalizeStrategyKind((strategyNode?.data as NodeData)?.strategy as string | undefined);
    // A LOOP graph has no 'strategy' node, so strategyKind defaults to 'Limit Order' — which would
    // route the order through the single-strategy PRICE path (encrypted price bounds + FHE evaluate)
    // and the executor FHE-400s a time-based DCA/TWAP forever. The compiled plan already carries the
    // real type (graphRunPlan sets strategy_type=DCA/TWAP/RANGE_GRID for repeat groups), so derive the
    // effective kind from it and route loop strategies through the multi-leg split path.
    const effectiveKind =
      bounds.strategy_type === 'TWAP' ? 'TWAP' :
      bounds.strategy_type === 'DCA' ? 'DCA' :
      bounds.strategy_type === 'RANGE_GRID' ? 'Range' :
      strategyKind;
    let effectiveAmountStr = amountStr;
    let effectiveAmount = amount;
    if (strategyKind === 'Stop Loss' || strategyKind === 'Take Profit') {
      const pct = resolvePositionPct({ positionPct: getValue(strategyNode?.id, 'positionPct') });
      if (pct < 100) {
        const full = parseFloat(amountStr) || 0;
        effectiveAmount = full * pct / 100;
        effectiveAmountStr = String(effectiveAmount);
        addLog(`Position ${pct}% → ${strategyKind} acts on ${effectiveAmountStr} of ${full} ${assetIn}`);
      }
    }

    const depositChainLabel = depositNode
      ? getRunStepFieldValue(runModeValues, depositNode.id, 'chain', depositNode.data as NodeData)
      : getRunModeChainLabel(activeChainId);
    // Solana Devnet runs its own vault (Phantom notes, Meteora / Jupiter Earn settlement): the EVM
    // path below cannot serve it, and the chain resolver has no entry for it.
    if (activeChainId === 900_002 || /solana devnet/i.test(depositChainLabel)) {
      setIsFading(true);
      try {
        const devnet = await import('../../../lib/chains/solanaDevnetStrategy');
        const lendNode = modalStrategyNodes.find((n) => (n.data as NodeData)?.type === 'lend');
        const { pipelineHopsFromCanvas, flattenPipelineSpecs } = await import(
          '../../../builder_agent/pipelineHops'
        );
        const canvasHops = pipelineHopsFromCanvas(modalStrategyNodes);
        if (canvasHops.length >= 2) {
          const hops = flattenPipelineSpecs(canvasHops);
          const armedPipe = await devnet.armSolanaDevnetPipeline({
            hops,
            amountHuman: parseFloat(effectiveAmountStr) || 0,
            maxSlippageBps: bounds.max_slippage_bps ?? undefined,
            windowHours: runDurationHours,
            executeNow: true,
            onStatus: addLog,
          });
          addLog(
            `Pipeline armed — ${armedPipe.hops} hops (${hops.map((h) => `${h.assetIn}→${h.assetOut}`).join(' → ')}); TEE proves each hop after the prior return.`,
          );
          window.dispatchEvent(new CustomEvent('siphon:strategySubmitted', {
            detail: { strategyId: armedPipe.strategyId, userId: recipient },
          }));
          finishSuccessfulRun();
          return;
        }
        if (lendNode) {
          const lendData = lendNode.data as NodeData;
          const lendActionRaw = String(
            getRunStepFieldValue(runModeValues, lendNode.id, 'lendAction', lendData) ||
              lendData?.lendAction ||
              'enter',
          ).toLowerCase();
          const lendAction = lendActionRaw === 'exit' ? 'exit' : 'enter';
          const lendVenue = String(
            getRunStepFieldValue(runModeValues, lendNode.id, 'lendVenue', lendData) ||
              lendData?.lendVenue ||
              'jupiter',
          ).toLowerCase();
          if (lendVenue === 'jito') {
            const armedStake = await devnet.armSolanaDevnetStake({
              action: lendAction,
              amountHuman: parseFloat(effectiveAmountStr) || 0,
              windowHours: runDurationHours,
              onStatus: addLog,
            });
            addLog(
              lendAction === 'enter'
                ? 'Jito stake placed — SOL becomes a private JitoSOL note.'
                : 'Jito unstake placed — JitoSOL redeems to a private SOL note.',
            );
            window.dispatchEvent(new CustomEvent('siphon:strategySubmitted', {
              detail: { strategyId: armedStake.strategyId, userId: recipient },
            }));
            finishSuccessfulRun();
            return;
          }
          const armedEarn = await devnet.armSolanaDevnetEarn({
            action: lendAction,
            amountHuman: parseFloat(effectiveAmountStr) || 0,
            windowHours: runDurationHours,
            onStatus: addLog,
          });
          addLog(
            lendAction === 'enter'
              ? 'Earn Enter placed — USDC becomes a private jlUSDC (Earn shares) note.'
              : 'Earn Exit placed — jlUSDC redeems to a private USDC note (+yield).',
          );
          window.dispatchEvent(new CustomEvent('siphon:strategySubmitted', {
            detail: { strategyId: armedEarn.strategyId, userId: recipient },
          }));
          finishSuccessfulRun();
          return;
        }
        if (effectiveKind === 'TWAP' || effectiveKind === 'DCA' || effectiveKind === 'Range') {
          // Multi-leg: one note split into a slice per leg, each proved and returned on its own.
          const timed = effectiveKind !== 'Range';
          const armedMl = await devnet.armSolanaDevnetMultiLeg({
            kind: effectiveKind === 'Range' ? 'RANGE_GRID' : effectiveKind,
            amountHuman: parseFloat(effectiveAmountStr) || 0,
            assetIn: assetIn || 'SOL',
            assetOut: assetOut || 'USDC',
            legCount: (timed ? bounds.slices : bounds.grid_levels) ?? 0,
            intervalSec: bounds.interval_sec ?? 60,
            low: bounds.lower_bound ?? 0,
            high: bounds.upper_bound ?? 0,
            maxSlippageBps: bounds.max_slippage_bps ?? undefined,
            windowHours: runDurationHours,
            onStatus: addLog,
          });
          addLog(`${effectiveKind} placed — ${armedMl.legs} legs; each leg's output comes back into your Devnet vault.`);
          window.dispatchEvent(new CustomEvent('siphon:strategySubmitted', {
            detail: { strategyId: armedMl.strategyId, userId: recipient },
          }));
          finishSuccessfulRun();
          return;
        }
        if (effectiveKind !== 'Limit Order' && effectiveKind !== 'Stop Loss' && effectiveKind !== 'Take Profit') {
          throw new Error(`${effectiveKind} is not available on Solana Devnet.`);
        }
        const armed = await devnet.armSolanaDevnetOrder({
          amountHuman: parseFloat(effectiveAmountStr) || 0,
          assetIn: assetIn || 'SOL',
          assetOut: assetOut || 'USDC',
          strategyType: bounds.strategy_type,
          conditionTree: bounds.condition_tree ?? undefined,
          upperBound: bounds.upper_bound,
          lowerBound: bounds.lower_bound,
          maxSlippageBps: bounds.max_slippage_bps ?? undefined,
          windowHours: runDurationHours,
          onStatus: addLog,
        });
        addLog('Order placed — when it fires, the output comes back into your Devnet vault.');
        window.dispatchEvent(new CustomEvent('siphon:strategySubmitted', {
          detail: { strategyId: armed.strategyId, userId: recipient },
        }));
        finishSuccessfulRun();
      } catch (error: unknown) {
        const raw = error instanceof Error ? error.message : String(error ?? "");
        // Phantom often returns bare "Unexpected error" on Devnet sim/sign failures.
        const msg = /unexpected error/i.test(raw)
          ? `${raw} — check Phantom is on Solana Devnet, you have a vault note for the deposit asset, and ≥0.05 SOL for fees.`
          : friendlyTxError(error);
        addLog(`Execution failed: ${msg}`);
        showToast(msg, 'error');
        setIsExecuting(false);
        setIsFading(false);
      }
      return;
    }

    const fromChainId = resolveRunModeChainId(depositChainLabel);
    // Vault-mode keeps the output in the deposit chain's vault — always same-chain (no bridge).
    const toChainId = fromChainId;
    if (fromChainId == null) {
      showToast('Please select a deposit chain (Base, Arbitrum One or ETH Testnet).', 'error');
      setIsExecuting(false);
      return;
    }

    setIsFading(true);

    try {
      addLog('Scanning deposits...');
      
      // Small delay to show the scanning message
      await new Promise(resolve => setTimeout(resolve, 300));

      addLog(`Switching to ${getNetwork(fromChainId).name}...`);
      const switchResult = await selectChainAndSwitchWallet(fromChainId, resolveWalletAddress());
      if (!switchResult.ok) {
        throw new Error(switchResult.error || 'Failed to switch wallet to deposit chain');
      }
      setActiveChainId(fromChainId);
      
      const tokenMap = getTokens(fromChainId);
      const tokenInfo = tokenMap[(assetIn || 'USDC').toUpperCase()];
      if (!tokenInfo) throw new Error(`Token ${assetIn} not supported for ZK operations`);

      // "Withdraw to <chain>": when the order fires the executor pays it out there through LI.FI.
      // The home chain itself keeps the output private in the vault, as before.
      const withdrawNode = modalStrategyNodes.find(n => (n.data as NodeData).type === 'withdraw');
      const payoutDest = withdrawNode
        ? payoutDestFor(fromChainId, String(getValue(withdrawNode.id, 'chain') || ''))
        : null;
      const withdrawChain = withdrawNode ? String(getValue(withdrawNode.id, 'chain') || '') : '';
      // Presets stamp full names ("Base Mainnet"), so compare chains, not labels.
      if (withdrawChain && !payoutDest && resolveRunModeChainId(withdrawChain) !== fromChainId) {
        throw new Error(`Payouts to ${withdrawChain} run from the Base vault — withdraw on ${getNetwork(fromChainId).badgeLabel}, or switch to Base.`);
      }
      if (payoutDest && effectiveKind !== 'Limit Order' && effectiveKind !== 'Stop Loss' && effectiveKind !== 'Take Profit') {
        throw new Error(`Payouts to ${payoutDest.label} work for single orders for now — remove the Withdraw block to keep the output private.`);
      }

      // ── Multi-leg (TWAP / Grid): split the deposit into N shielded slice/rung legs, each with
      // its own swap proof + encrypted trigger; submit legs[] (no single zk_proof). ──
      // DCA is N equal time-scheduled buys = TWAP mechanics, so it rides the same multi-leg path.
      const isTimeMultiLeg = effectiveKind === 'TWAP' || effectiveKind === 'DCA';
      if (isTimeMultiLeg || effectiveKind === 'Range') {
        const outTokenMl = tokenMap[(assetOut || '').toUpperCase()];
        if (!outTokenMl) throw new Error(`Unsupported output asset: ${assetOut}`);
        const sliceCount = isTimeMultiLeg ? (bounds.slices ?? 0) : (bounds.grid_levels ?? 0);
        const unitLabel = effectiveKind === 'Range' ? 'grid levels' : effectiveKind === 'DCA' ? 'buys' : 'slices';
        if (!sliceCount || sliceCount < 2) throw new Error(`Need ≥2 ${unitLabel}`);

        addLog(`Splitting deposit into ${sliceCount} ${unitLabel} + building proofs…`);
        const clientKey = await getOrCreateClientKey(recipient);
        const submitSplit = (s: Parameters<typeof submitSplitOnChain>[2]) => submitSplitOnChain(fromChainId, tokenInfo, s);
        // v3 splits go to the kernel via /relaySpend; the executor resolves the kernel address from
        // trusted server config, never from this payload.
        const submitV3Spend = createExecutorSubmitV3(getSigner()!);

        // The execution window (expiry) MUST outlast the whole schedule, or later legs expire before
        // their fire-time — a 24h-interval DCA with the default 1h window can never fire leg 1. Floor
        // it at the last leg's fire-time ((sliceCount-1)×interval) plus a 1h buffer to execute; the
        // user's chosen window still wins if it's longer. Time strategies only — grid rungs are
        // price-triggered, not scheduled. The arming fee is fixed and independent of this window.
        const scheduleFloorHoursMl = isTimeMultiLeg
          ? ((Math.max(sliceCount - 1, 0) * (bounds.interval_sec ?? 60)) + 3600) / 3600
          : 0;
        const windowHoursMl = Math.max(runDurationHours, scheduleFloorHoursMl);
        // State the real charge before the wallet prompt: a schedule floor longer than the chosen
        // duration bumps the window into the next tier, so the receipt's quote (which prices the
        // chosen duration) can read one tier low for a tightly-scheduled TWAP.
        addLog(`Arming + ${windowHoursMl.toFixed(0)}h window: $${armingChargeUsd(windowHoursMl).toFixed(2)} USDC`);

        // Deposit the user-requested amount as ONE fresh note and split THAT note so every slice is
        // amount/N — NOT a divide of whatever the largest pre-existing note happens to be ("0.002 into
        // 3" once became a 0.000333 leftover ÷ 3). Validates the slice count + waits for the fresh leaf
        // before splitting; on any later failure the deposit is a normal recoverable vault note.
        //
        // v2 only: depositForSplit deposits into the v1 Entrypoint and carries requireV2StrategyPath,
        // so calling it on a v3 chain throws before the branch below is even reached. buildV3Multi does
        // the equivalent deposit-then-split against the kernel itself.
        const useV3 = v3StrategiesLive(fromChainId);
        const splitNoteKey = useV3
          ? ""
          : await depositForSplit(fromChainId, tokenInfo, effectiveAmountStr, sliceCount, addLog);

        // Each leg withdraws its slice → swaps → re-deposits the output into the asset_out vault.
        //
        // On a chain running the v3 kernel this routes through buildV3Multi instead: v3 cannot
        // build the leg proof here, because the circuit binds the ASP roots and a proof made at
        // arming is stale by the time the trigger fires. It seals the note secrets to the enclave
        // and the enclave proves at fire time. Same result shape, so everything below is unchanged.
        const multi = useV3
          ? await buildV3Multi({
              chainId: fromChainId,
              signer: getSigner()!,
              screenToken: "", // same-origin/proxied ASP reads, matching UserDash's v3 calls
              inToken: { address: tokenInfo.address, symbol: tokenInfo.symbol, decimals: tokenInfo.decimals },
              outToken: { address: outTokenMl.address, symbol: outTokenMl.symbol, decimals: outTokenMl.decimals },
              amountStr: effectiveAmountStr,
              sliceCount,
              windowHours: windowHoursMl,
              swap: await v3SwapParams(fromChainId, tokenInfo, outTokenMl, clampSlippageBps(bounds.max_slippage_bps ?? undefined)),
              encryptLeg: isTimeMultiLeg
                ? twapEncryptLeg(bounds.interval_sec ?? 60, clientKey)
                : gridEncryptLeg(bounds.lower_bound ?? 0, bounds.upper_bound ?? 0, sliceCount, tokenInfo.symbol, clientKey),
              submit: submitV3Spend,
              log: addLog,
            })
          : isTimeMultiLeg
          ? await buildTwapLegs({ chainId: fromChainId, inToken: tokenInfo, outToken: outTokenMl, sliceCount, intervalSec: bounds.interval_sec ?? 60, clientKeyHex: clientKey, submitSplit, splitNoteKey, maxSlippageBps: bounds.max_slippage_bps ?? undefined, windowHours: windowHoursMl })
          : await buildGridLegs({ chainId: fromChainId, inToken: tokenInfo, outToken: outTokenMl, low: bounds.lower_bound ?? 0, high: bounds.upper_bound ?? 0, levels: sliceCount, clientKeyHex: clientKey, submitSplit, splitNoteKey, maxSlippageBps: bounds.max_slippage_bps ?? undefined, windowHours: windowHoursMl });

        addLog(`Submitting ${multi.legs.length}-leg ${effectiveKind}…`);
        const mlResult = await submitEncryptedStrategy({
          user_id: recipient,
          strategy_type: effectiveKind === 'TWAP' ? 'TWAP' : effectiveKind === 'DCA' ? 'DCA' : 'RANGE_GRID',
          asset_in: assetIn || 'USDC',
          asset_out: assetOut,
          amount: effectiveAmount,
          recipient_address: recipient,
          legs: multi.legs,
          interval_sec: bounds.interval_sec,
          grid_levels: bounds.grid_levels,
          max_slippage_bps: bounds.max_slippage_bps,
          schedule_anchor: multi.scheduleAnchor,
          // Only the v3 builder arms in the enclave; the v2 shape has no such id.
          ...('armStrategyId' in multi ? { arm_strategy_id: multi.armStrategyId } : {}),
          // createStrategy hard-requires note_label. strategySubmit lifts it out of a leg's
          // zk_proof on the v2 path, and a v3 leg has none — so it must be passed explicitly.
          ...('noteLabel' in multi ? { note_label: multi.noteLabel } : {}),
          is_private: true,
          output_mode: 'vault' as const,
          arming_fee_wei: multi.armingFeeWei,
          arming_tx_hash: multi.armingTxHash,
          execution_window_sec: Math.round(windowHoursMl * 3600),
          from_chain: String(fromChainId),
          to_chain: String(toChainId ?? fromChainId),
        }, {
          onKeygen: () => addLog('Generating FHE keys…'),
          onUploadKey: () => addLog('Uploading FHE server key…'),
          onUploadClientKey: () => addLog('Securing your key in the attested enclave…'),
        });
        if (mlResult.success) {
          addLog(`✅ ${effectiveKind} registered — ${multi.legs.length} legs (split ${multi.splitTxHash.slice(0, 10)}…)`);
          window.dispatchEvent(new CustomEvent('siphon:strategySubmitted', { detail: { strategyId: String(mlResult.data?.strategy_id ?? ''), userId: recipient } }));
          finishSuccessfulRun();
        } else {
          addLog(`❌ ${mlResult.error}`);
          showToast(mlResult.error || 'Multi-leg submit failed', 'error');
          setIsExecuting(false);
          setIsFading(false);
        }
        return;
      }

      // Resolve the ETH/USD price BEFORE charging the non-refundable arming fee. The vault-swap
      // path hard-requires a live price (estimateMinOutWei refuses to guess slippage), and the
      // fee used to be collected first — so a missing price charged the user $0.25 for work that
      // could never run. `coinPrices` can legitimately be empty here: the reset effect clears it
      // whenever !isRunMode while the fetch effect populates on fromBuilder alone, so re-fetch
      // rather than trusting the cached state.
      let ethUsd = Number(coinPrices?.ETH ?? coinPrices?.eth ?? 0) || 0;
      if (!ethUsd) {
        try {
          const fresh = await fetchCoinPrices();
          ethUsd = Number(fresh?.ETH ?? fresh?.eth ?? 0) || 0;
        } catch { /* handled by the guard below */ }
      }
      if (!ethUsd) {
        const msg = 'Live ETH/USD price unavailable — not charging the arming fee. Retry in a moment.';
        addLog(`❌ ${msg}`);
        showToast(msg, 'error');
        setIsExecuting(false);
        setIsFading(false);
        return;
      }

      // Validate and price a payout now, so one that cannot route costs nothing.
      let payout: StrategyPayout | undefined;
      let payoutPayee: string | undefined;
      if (payoutDest) {
        const toAddress = String(getValue(withdrawNode?.id, 'wallet') || '').trim();
        if (!isValidDestAddress(payoutDest.kind, toAddress)) {
          throw new Error(`Enter your ${payoutDest.label} address in the Withdraw block.`);
        }
        const toToken = payoutToken(payoutDest, assetOut || '');
        if (!toToken) {
          throw new Error(
            payoutDest.kind === "zcash"
              ? `Payouts to Zcash deliver ZEC — keep a USDC (or ETH) note size of at least $${payoutDest.minUsdc ?? 10}, or keep the output private.`
              : `Payouts to ${payoutDest.label} deliver USDC — set the swap to output USDC, or keep the output private.`,
          );
        }
        const inSym = (assetIn || 'USDC').toUpperCase();
        const usdIn = (parseFloat(effectiveAmountStr) || 0) * (inSym === 'ETH' ? ethUsd : 1);
        const minUsd = Math.max(1, payoutDest.minUsdc ?? 0);
        if (usdIn < minUsd) {
          throw new Error(`Payouts to ${payoutDest.label} need at least $${minUsd} — this order is about $${usdIn.toFixed(2)}.`);
        }
        addLog(`Pricing the payout to ${payoutDest.label}…`);
        const q = await bridgeQuote(
          {
            to_chain_id: payoutDest.id,
            to_address: toAddress,
            to_token: toToken,
            amount: ethers.parseUnits(effectiveAmountStr, tokenInfo.decimals).toString(),
            min_out: '1',
            refund_address: recipient,
            ...(inSym === 'ETH' ? { from_token: 'ETH' as const } : {}),
          },
          fromChainId,
        );
        const slippageBps = Math.min(clampSlippageBps(bounds.max_slippage_bps ?? undefined), 1000);
        // At fire time the executor refuses a route worth less than the oracle value minus slippage
        // and a 3% fee allowance (bridge_payout.fire_min_out). A route already below that would sit
        // armed and never fire, so refuse it while nothing has been charged.
        const outUsd = /^USDC/i.test(q.toToken.symbol) ? Number(q.toAmountMin) / 10 ** q.toToken.decimals : null;
        if (outUsd != null && outUsd < usdIn * (1 - (slippageBps + 300) / 10_000)) {
          throw new Error(`The route to ${payoutDest.label} costs about $${(usdIn - outUsd).toFixed(2)} of $${usdIn.toFixed(2)} at this size — try a larger amount.`);
        }
        addLog(`Payout to ${payoutDest.label}: ~${ethers.formatUnits(q.toAmount, q.toToken.decimals)} ${q.toToken.symbol} at today's price (fee ~$${q.feeUsd}, ~${Math.max(1, Math.ceil(q.durationSec / 60))} min) — fills at your trigger price`);
        payout = { to_chain_id: payoutDest.id, to_address: toAddress, to_token: toToken, refund_address: recipient, slippage_bps: slippageBps };
        payoutPayee = q.payee;
      }

      // NOTE: the arming fee is collected AFTER proof generation (see below), not here. Every
      // failure mode between this point and a finished proof — label not yet ASP-admitted, no
      // spendable note, readiness probe, prover error — used to charge the user $0.25 for work
      // that never ran. The fee is still upfront relative to *execution*; it is just no longer
      // charged for an arm that cannot be built.

      // Generate ZK proof for strategy execution using full deposit amount
      const outToken = getTokens(fromChainId)[(assetOut || '').toUpperCase()];
      const isSameChainOutput =
        String(toChainId ?? fromChainId) === String(fromChainId);
      const sameAsset =
        (assetIn || '').toUpperCase() === (assetOut || '').toUpperCase();
      const useAtomicVaultSwap =
        isSameChainOutput && !!outToken && !sameAsset;

      let withdrawalTxData: {
        pA: unknown;
        pB: unknown;
        pC: unknown;
        nullifierHashes: string[];
        publicSignals?: unknown;
        nullifierHash?: string;
        newCommitment?: string;
        stateRoot: string;
        aspRoot?: string;
        changeLabel?: string;
        newLabel?: string;
        amountIn?: string;
        recipient?: string;
        pool?: string;
        dstToken?: string;
        fee?: number;
        minAmountOut?: string;
        nullifier?: string;
        venue?: string;
        /** withdraw._changeValue / ZKProof.changeValue — set by both the swap and withdraw paths. */
        changeValue?: string;
      };
      let spentDepositKey: string | null | undefined;
      let newDeposit: { commitment?: string; nullifier: string; secret: string; precommitment?: string; nullifierHash?: string; label?: string; amount: string } | undefined;
      let newDepositKey: string | undefined;
      let outputMode: 'vault' | 'address' | 'bridge' = 'address';
      let outputPrecommitment: string | undefined;
      // Set only on the v3 path, which produces no withdrawalTxData to read the label from.
      let v3NoteLabel: string | undefined;
      let v3Single: { armStrategyId: string; scheduleAnchor: number } | undefined;

      // On a v3 chain a single-leg order arms through the ENCLAVE instead of building a proof
      // here. armSameChainVaultSwap proves against the v1 Entrypoint's tree, whose root the v3
      // kernel has never seen, so that path could only fail with UnknownStateRoot after gas.
      if (payout && !(useAtomicVaultSwap && v3StrategiesLive(fromChainId))) {
        throw new Error(`Payouts to ${payoutDest!.label} need a swap on ${getNetwork(fromChainId).name}.`);
      }
      if (useAtomicVaultSwap && v3StrategiesLive(fromChainId)) {
        const { buildV3Single } = await import('../../../lib/v3/strategyOrchestrateV3');
        // Hoisted out of the call below: it resolves the pool on-chain and fetches prices, which is
        // seconds of RPC. Inline in the argument list it ran BEFORE the "sealing" line was even
        // logged, so the modal showed the previous step while this was what the user waited on.
        // A payout leg is a withdraw — LI.FI does the swap when it fires, so there is no pool.
        if (!payout) addLog(`Finding the best ${tokenInfo.symbol}/${outToken.symbol} pool on ${getNetwork(fromChainId).name}...`);
        const v3Swap = payout ? undefined : await v3SwapParams(fromChainId, tokenInfo, outToken, clampSlippageBps(bounds.max_slippage_bps ?? undefined));

        addLog(`Sealing this order to the enclave on ${getNetwork(fromChainId).name}...`);
        const single = await buildV3Single({
          chainId: fromChainId,
          signer: getSigner()!,
          screenToken: "",
          inToken: { address: tokenInfo.address, symbol: tokenInfo.symbol, decimals: tokenInfo.decimals },
          outToken: { address: outToken.address, symbol: outToken.symbol, decimals: outToken.decimals },
          amountStr: effectiveAmountStr,
          windowHours: runDurationHours,
          swap: v3Swap,
          payee: payoutPayee,
          submit: createExecutorSubmitV3(getSigner()!),
          log: addLog,
        });
        addLog('Order sealed to the enclave — it will prove when the trigger fires');
        outputMode = payout ? 'bridge' : 'vault';
        outputPrecommitment = single.outputPrecommitment;
        v3NoteLabel = single.noteLabel;
        v3Single = single;
      } else if (useAtomicVaultSwap) {
        addLog(`Generating atomic swap+re-shield proof on ${getNetwork(fromChainId).name}...`);
        const { armSameChainVaultSwap } = await import('../../../lib/atomicVaultSwap');
        // ethUsd resolved (and guarded) before the arming fee above — do not re-read coinPrices.
        const armed = await armSameChainVaultSwap({
          chainId: fromChainId,
          inToken: tokenInfo,
          outToken,
          amountHuman: effectiveAmountStr,
          ethUsdPrice: ethUsd,
          maxSlippageBps: bounds.max_slippage_bps ?? 100,
        });
        if ('error' in armed) throw new Error(armed.error);
        addLog('Atomic vault-swap proof generated');
        outputMode = 'vault';
        outputPrecommitment = armed.outputPrecommitment;
        spentDepositKey = armed.swapProof.spentNoteKey;
        withdrawalTxData = armed.zkpData as typeof withdrawalTxData;
        const chg = armed.swapProof.change;
        const chgWei = BigInt(chg.amountWei || '0');
        if (chgWei > 0n) {
          const { noteKey } = await import('../../../lib/localNoteStore');
          newDeposit = {
            nullifier: chg.nullifier,
            secret: chg.secret,
            commitment: chg.commitment,
            precommitment: chg.precommitment,
            label: chg.label,
            amount: ethers.formatUnits(chgWei, tokenInfo.decimals),
          };
          newDepositKey = noteKey(fromChainId, tokenInfo.symbol, chg.commitment);
        }
      } else {
        addLog(`Generating ZK proof on ${getNetwork(fromChainId).name}...`);
        const zkResult = await generateZKData(
          fromChainId,
          tokenInfo,
          effectiveAmountStr,
          getZkWithdrawRecipient(fromChainId),
        );
        if ('error' in zkResult) throw new Error(zkResult.error);
        addLog('ZK proof generated');
        withdrawalTxData = zkResult.withdrawalTxData;
        spentDepositKey = zkResult.spentDepositKey;
        newDeposit = zkResult.newDeposit;
        newDepositKey = zkResult.newDepositKey;
        if (isSameChainOutput && outToken) {
          const out = await createVaultOutputNote(fromChainId, outToken);
          outputMode = 'vault';
          outputPrecommitment = out.precommitment;
          addLog(`Vault-output note prepared (stays private in ${(assetOut || '').toUpperCase()} vault)`);
        }
      }

      // Proof is built and the output note exists — the arm WILL be submitted, so charge now.
      // Moved here from before proof generation so a failed/impossible arm costs the user nothing.
      addLog(`Arming + ${runDurationHours.toFixed(0)}h window: $${armingChargeUsd(runDurationHours).toFixed(2)} USDC`);
      const ssArming = await collectArmingFee(fromChainId, runDurationHours);
      addLog('Arming fee transferred to executor');

      addLog('Building strategy payload...');
      const strategyPayload = {
        user_id: recipient,
        strategy_type: bounds.strategy_type,
        asset_in: assetIn || "USDC",
        asset_out: assetOut,
        amount: effectiveAmount,
        // A Limit Order carries its trigger in condition_tree (buildGraphRunPlan). When present, the
        // executor evaluates the tree, so the flat bounds are unused — zero them to avoid a stale
        // upper_bound (e.g. a default 1500) firing the order early.
        upper_bound: bounds.condition_tree ? 0 : bounds.upper_bound,
        lower_bound: bounds.condition_tree ? 0 : bounds.lower_bound,
        ...(bounds.condition_tree != null ? { condition_tree: bounds.condition_tree } : {}),
        recipient_address: recipient,
        ...(bounds.grid_levels != null ? { grid_levels: bounds.grid_levels } : {}),
        ...(bounds.slices != null ? { slices: bounds.slices } : {}),
        ...(bounds.interval_sec != null ? { interval_sec: bounds.interval_sec } : {}),
        ...(bounds.start_delay_sec != null && bounds.start_delay_sec > 0
          ? { start_delay_sec: bounds.start_delay_sec }
          : {}),
        ...(bounds.max_slippage_bps != null ? { max_slippage_bps: bounds.max_slippage_bps } : {}),
        from_chain: String(fromChainId),
        to_chain: String(toChainId ?? fromChainId),
        output_mode: outputMode,
        output_precommitment: outputPrecommitment,
        ...(payout ? { payout } : {}),
        // Execution window: the order expires (scheduler._is_expired) once this elapses. Both
        // fields are required for expiry — schedule_anchor is the creation time it counts from.
        execution_window_sec: Math.round(runDurationHours * 3600),
        // On the v3 path this is the anchor buildV3Single ARMED with — the two are one value, and
        // a second Date.now() here would differ by however long the arm took.
        schedule_anchor: v3Single?.scheduleAnchor ?? Math.floor(Date.now() / 1000),
        // Tells the executor which id the enclave keys these legs by. Without it /spend/prove
        // asks for the row id, finds no armed leg, and the order expires unfired.
        ...(v3Single ? { arm_strategy_id: v3Single.armStrategyId } : {}),
        arming_fee_wei: ssArming.armingCollectedWei.toString(),
        arming_tx_hash: ssArming.armingTxHash,
        // Hard ASP: the executor re-checks the spent note's label against the live association set
        // before arming and then DROPS it (app.py — never stored on Strategy, never re-logged).
        // Without it createStrategy 400s with "note_label required for Hard ASP arming".
        // Association inheritance means the output label == the spent note's label, so the atomic
        // swap path's `newLabel` and the withdrawal path's `changeLabel` are both the right value.
        note_label: v3NoteLabel ?? withdrawalTxData!.newLabel ?? withdrawalTxData!.changeLabel,
        // OMITTED on the v3 path, and that absence is load-bearing: it is what routes the
        // strategy through the executor's attested path (executor_runner._is_attested_strategy),
        // where the enclave proves at fire time instead. There is no proof to send here.
        ...(v3NoteLabel ? {} : { zk_proof: {
          pA: withdrawalTxData!.pA,
          pB: withdrawalTxData!.pB,
          pC: withdrawalTxData!.pC,
          nullifierHashes: withdrawalTxData!.nullifierHashes,
          noteCount: withdrawalTxData!.nullifierHashes?.length ?? 1,
          publicSignals: withdrawalTxData!.publicSignals,
          nullifierHash: withdrawalTxData!.nullifierHash || withdrawalTxData!.nullifier,
          nullifier: withdrawalTxData!.nullifier || withdrawalTxData!.nullifierHash,
          newCommitment: withdrawalTxData!.newCommitment,
          changeCommitment: withdrawalTxData!.newCommitment,
          stateRoot: withdrawalTxData!.stateRoot,
          // Hard ASP: _hard_asp_swap_proof_tuple (swap) and the withdraw path both encode these
          // into the on-chain IVault.ZKProof and hard-fail at FIRE time without them — the arm
          // succeeds, then execution dies with "missing aspRoot/newLabel/changeLabel".
          aspRoot: withdrawalTxData!.aspRoot,
          newLabel: withdrawalTxData!.newLabel,
          changeLabel: withdrawalTxData!.changeLabel ?? withdrawalTxData!.newLabel,
          // Entrypoint.withdraw._changeValue / IVault.ZKProof.changeValue. Private circuit
          // input, so the executor cannot recover it — it must ride along with the proof.
          changeValue: withdrawalTxData!.changeValue,
          ...(withdrawalTxData!.pool
            ? {
                venue: 'swap_and_deposit',
                amountIn: withdrawalTxData!.amountIn,
                recipient: withdrawalTxData!.recipient,
                pool: withdrawalTxData!.pool,
                dstToken: withdrawalTxData!.dstToken,
                fee: withdrawalTxData!.fee,
                minAmountOut: withdrawalTxData!.minAmountOut,
              }
            : {}),
        } }),
      };

      addLog('Encrypting bounds client-side and submitting...');
      const result = await submitEncryptedStrategy(strategyPayload, {
        onKeygen:    () => addLog('Generating FHE keys (one-time, ~5s)...'),
        onUploadKey: () => addLog('Uploading FHE server key (one-time)...'),
        onUploadClientKey: () => addLog('Securing your key in the attested enclave (decrypt-only there)…'),
        onEncrypt:   () => addLog('Encrypting price bounds locally...'),
      });

      if (result.success) {
        addLog(
          plan.isScheduled
            ? 'Strategy registered! Scheduler will run on cadence...'
            : 'Strategy registered! Waiting for price trigger...'
        );
        if (payout) addLog(`When it fires, the executor pays it out to ${payoutDest!.label} — follow it in Activity.`);

        if (newDeposit && newDepositKey) {
          const _signer = getSigner();
          if (_signer) {
            const { writeNoteTyped, parseNoteKey } = await import('../../../lib/localNoteStore');
            const parsed = parseNoteKey(newDepositKey);
            if (parsed) {
              const commitment = newDeposit.commitment ?? parsed.commitment;
              await writeNoteTyped(parsed.chainId, parsed.symbol, {
                nullifier:     newDeposit.nullifier,
                secret:        newDeposit.secret,
                commitment,
                precommitment: newDeposit.precommitment ?? '',
                nullifierHash: newDeposit.nullifierHash ?? '',
                label:         newDeposit.label,
                amount:        newDeposit.amount,
                spent:         'false',
              }, _signer).catch(e => console.warn('[strategy] change note encrypt failed:', e));

              // Back the change note to Supabase too (writeNoteTyped is localStorage-only).
              // Mirrors the withdraw path (handler.ts) — without this, a strategy's change note
              // is unspendable after a storage clear / device switch (it isn't in the backup
              // that syncFromServer restores from).
              try {
                const { postCommitment } = await import('../../../lib/commitmentStore');
                await postCommitment(
                  _signer,
                  {
                    nullifier:     newDeposit.nullifier,
                    secret:        newDeposit.secret,
                    commitment,
                    amount:        newDeposit.amount,
                    chainId:       parsed.chainId,
                    nullifierHash: newDeposit.nullifierHash ?? '',
                    precommitment: newDeposit.precommitment ?? '',
                    label:         newDeposit.label,
                  },
                  parsed.symbol,
                  'change',
                );
              } catch (e) {
                console.warn('[strategy] change note Supabase backup failed:', e);
              }
            }
          }
        }

        if (runningStrategies && setRunningStrategies) {
          const newRunning = new Map(runningStrategies);
          newRunning.set(selectedStrategy.name, {
            startTime: Date.now(),
            isRunning: true,
            loop: plan.isScheduled,
          });
          setRunningStrategies(newRunning);
        }

        // Strategy is registered with the trade-executor, which evaluates and executes it
        // server-side. No local FHE decryption / browser authorization needed.
        const strategyId = String(result.data?.strategy_id ?? result.data?.payload_id ?? '');
        if (strategyId) {
          addLog('Strategy registered — it will execute server-side when the price triggers.');
          window.dispatchEvent(
            new CustomEvent('siphon:strategySubmitted', { detail: { strategyId, userId: recipient } }),
          );
          // Deleted, not marked spent:'true' — deliberate. The note is only spent once the
          // executor's tx lands, so a local 'true' would out-rank the server's 'false' in
          // syncFromServer and push markCommitmentSpent('true') to Supabase, stranding an
          // on-chain-unspent note on every device. Deleting keeps it out of selection here
          // while letting syncFromServer restore it as spendable if execution fails.
          if (spentDepositKey) { try { localStorage.removeItem(spentDepositKey); } catch {} }
        }
        finishSuccessfulRun();
      } else {
        addLog(`Error: ${result.error}`);
        showToast(
          `Strategy generation failed: ${(result.error ?? 'Unknown error').slice(0, 200)}`,
          'error',
        );
        setIsExecuting(false);
        setTimeout(() => setExecutionLogs([]), 3000);
      }
    } catch (error: unknown) {
      const errorMessage = friendlyTxError(error);
      addLog(`Execution failed: ${errorMessage}`);
      showToast(errorMessage, 'error');
      setIsExecuting(false);
      setTimeout(() => setExecutionLogs([]), 3000);
    } finally {
      setIsFading(false);
    }
  };

  const handleEdit = () => {
    if (modalStrategyNodes.length > 0 && modalStrategyEdges.length > 0) {
      setNodes(modalStrategyNodes as Node[]);
      setEdges(modalStrategyEdges as Edge[]);
      setCurrentFileName(`${selectedStrategy.name}.io`);
      setViewMode('blueprint');
      handleClose();

      const existingScene = savedScenes.find(s => s.name === selectedStrategy.name);
      if (!existingScene) {
        const newScene = {
          name: selectedStrategy.name,
          nodes: modalStrategyNodes as Node[],
          edges: modalStrategyEdges as Edge[]
        };
        const updatedScenes = [...savedScenes, newScene];
        setSavedScenes(updatedScenes);
        localStorage.setItem('siphon-blueprint-scenes', JSON.stringify(updatedScenes));
      }
      return;
    }

    showToast('No graph loaded for this strategy yet.', 'error');
  };

  const handleSave = () => {
    const discoverStrategiesKey = 'siphon-discover-strategies';
    const stored = localStorage.getItem(discoverStrategiesKey);
    if (stored) {
      try {
        const strategiesData = JSON.parse(stored);
        const strategyData = strategiesData[selectedStrategy.name];
        if (strategyData) {
          const savedStrategy = {
            ...strategyData,
            runValues: runModeValues
          };
          strategiesData[selectedStrategy.name] = savedStrategy;
          localStorage.setItem(discoverStrategiesKey, JSON.stringify(strategiesData));
          console.log('Strategy saved with run values');
          handleClose();
        }
      } catch (error) {
        console.error('Failed to save strategy:', error);
      }
    }
  };

  // Get the latest log message for the central notification
  const latestLog = executionLogs.length > 0 ? executionLogs[executionLogs.length - 1] : null;
  const notificationMessage = toast?.message || latestLog || '';
  const notificationType = toast?.type || (isExecuting ? 'loading' : 'info');

  return createPortal(
    <>
      {(isExecuting || toast) && (
        <div className={`strategy-toast strategy-toast-${notificationType} strategy-toast-central ${isFadingOut ? 'fade-out' : ''}`}>
            <div className="strategy-toast-content">
              {notificationType === 'loading' && (
                <div className="strategy-toast-loader">
                  <div className="strategy-toast-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              )}
              <div className="strategy-toast-message">{notificationMessage}</div>
            </div>
        </div>
      )}
      {fromBuilder ? (
        <div
          className={`builder-run-overlay${isExecuting ? " builder-run-overlay--dark" : ""}`}
          onClick={handleClose}
          role="presentation"
        >
          <article
            className="builder-run-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="builder-run-title"
          >
            <header className="builder-run-card-header">
              <button
                className="builder-run-close"
                onClick={handleClose}
                aria-label="Close"
                type="button"
                disabled={isExecuting}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
              <div className="builder-run-card-heading">
                <p className="builder-run-receipt-eyebrow">Execution summary</p>
                <h2 className="builder-run-receipt-title" id="builder-run-title">
                  {selectedStrategy.name}
                </h2>
                {selectedStrategy.author && (
                  <p className="builder-run-receipt-author">by {selectedStrategy.author}</p>
                )}
              </div>
            </header>

            <div className="builder-run-card-body">
              <div className="builder-run-receipt-io">
                  <div className="builder-run-receipt-io-col">
                    <span className="builder-run-receipt-io-label">You Send</span>
                    <span className="builder-run-receipt-io-amount">
                      {pricesLoaded ? formatAmount(runSummary.inputAmount, runSummary.inputCoin) : "…"}
                    </span>
                    <span className="builder-run-receipt-io-coin">{runSummary.inputCoin}</span>
                    <span className="builder-run-receipt-io-usd">
                      {pricesLoaded ? formatUsd(runSummary.inputUsd) : "…"}
                    </span>
                  </div>
                  <span className="builder-run-receipt-io-arrow" aria-hidden>
                    →
                  </span>
                  <div className="builder-run-receipt-io-col builder-run-receipt-io-col--receive">
                    <span className="builder-run-receipt-io-label">You receive (est.)</span>
                    <span className="builder-run-receipt-io-amount builder-run-receipt-io-amount--estimate">
                      <span className="builder-run-receipt-io-circa" aria-hidden>≈</span>
                      {pricesLoaded ? formatAmount(runSummary.outputAmount, runSummary.outputCoin) : "…"}
                    </span>
                    <span className="builder-run-receipt-io-coin">{runSummary.outputCoin}</span>
                    <span className="builder-run-receipt-io-usd">
                      {pricesLoaded ? formatUsd(runSummary.outputUsd) : "…"}
                    </span>
                  </div>
                </div>

                <div className="builder-run-stats-grid">
                  <div className="builder-run-stat">
                    <span className="builder-run-stat-label">Strategy</span>
                    <span className="builder-run-stat-value">{runSummary.strategyKind}</span>
                  </div>
                  <div className="builder-run-stat">
                    <span className="builder-run-stat-label">Chain</span>
                    <span className="builder-run-stat-value">{runSummary.depositChain}</span>
                  </div>
                  <div className="builder-run-stat">
                    <span className="builder-run-stat-label">Steps</span>
                    <span className="builder-run-stat-value">{runSummary.stepCount}</span>
                  </div>
                  <div className="builder-run-stat">
                    <span className="builder-run-stat-label">Exec time</span>
                    <span className="builder-run-stat-value">{executionTime} sec</span>
                  </div>
                </div>
                {runSummary.pathLabel ? (
                  <p className="builder-run-receipt-path" title={runSummary.pathLabel}>
                    Path: {runSummary.pathLabel}
                  </p>
                ) : null}

                {runSummary.stepCount > 0 && (
                  <div className="builder-run-receipt-steps-wrap">
                    <button
                      type="button"
                      className="builder-run-receipt-steps-toggle"
                      onClick={() => setBuilderStepsOpen((open) => !open)}
                      aria-expanded={builderStepsOpen}
                    >
                      {builderStepsOpen ? "Hide steps" : "Review steps"}
                      <span className="builder-run-receipt-steps-count">
                        ({runSummary.stepCount})
                      </span>
                    </button>
                    {builderStepsOpen && (
                      <div className="builder-run-steps-panel">
                        {renderEditableRunSteps()}
                      </div>
                    )}
                  </div>
                )}

                <div className="builder-run-receipt-divider" aria-hidden />

                <p className="builder-run-costs-heading">Cost review</p>
                <dl className="builder-run-receipt-costs">
                  <div className="builder-run-receipt-cost-row">
                    <dt>Arming fee</dt>
                    <dd>${baseFee.toFixed(2)}</dd>
                  </div>
                  <div className="builder-run-receipt-cost-row">
                    <dt>Execution window</dt>
                    <dd className="builder-run-receipt-window">
                      <select
                        className="builder-run-receipt-duration"
                        value={runDuration}
                        onChange={(e) => setRunDuration(e.target.value)}
                        aria-label="Execution window"
                      >
                        {WINDOW_OPTIONS.map(([value, , label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <span className="builder-run-receipt-window-price">
                        ${windowFeeUsd(runDurationHours).toFixed(2)}
                      </span>
                    </dd>
                  </div>
                  <div className="builder-run-receipt-cost-row">
                    <dt>Execution fee</dt>
                    <dd>
                      {costIsMultiLeg || execFeeUsd <= 0
                        ? `${(FEE.EXEC_BPS / 100).toFixed(2)}% of notional`
                        : `$${execFeeUsd.toFixed(2)}`}
                    </dd>
                  </div>
                  <div className="builder-run-receipt-cost-row">
                    <dt>Total upfront</dt>
                    <dd>${armingUsd.toFixed(2)} USDC</dd>
                  </div>
                </dl>
            </div>

            <div className={`builder-run-actions ${isFading ? "fade-out" : "fade-in"}`}>
              <button
                className={`builder-run-submit ${!isWalletConnected ? "builder-run-submit--disabled" : ""}`}
                onClick={handleExecute}
                disabled={isExecuting}
                type="button"
              >
                {isExecuting ? "Processing…" : !isWalletConnected ? "Connect wallet" : "Pay & run"}
              </button>
            </div>
          </article>
        </div>
      ) : (
      <div
        className={`strategy-modal-overlay ${isExecuting ? "darkened" : ""}`}
        onClick={handleClose}
        role="dialog"
        aria-modal="true"
        aria-labelledby="strategy-modal-title"
      >
        <div className="strategy-modal" onClick={(e) => e.stopPropagation()}>
        <div className="strategy-modal-header">
          <div className="strategy-modal-header-name">
            <h2 className="strategy-modal-title" id="strategy-modal-title">{selectedStrategy.name}</h2>
            <p className="strategy-modal-author">by {selectedStrategy.author}</p>
            <ChainToggle className="strategy-modal-categories" />
          </div>
          <button 
            className="strategy-modal-close"
            onClick={handleClose}
            aria-label="Close modal"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        
        <div className="strategy-modal-content">
          {isRunMode ? (
            <React.Fragment>
              <div className="strategy-modal-info">
                {/* Input/Output Section for Run Mode */}
                {(() => {
                  const depositNodes = modalStrategyNodes.filter(node => (node.data as NodeData)?.type === 'deposit');
                  const swapNodes = modalStrategyNodes.filter(node => (node.data as NodeData)?.type === 'swap');
                  const lendNodes = modalStrategyNodes.filter(node => (node.data as NodeData)?.type === 'lend');
                  const pipePath = pipelinePathSummary(modalStrategyNodes);
                  
                  const depositStepId = depositNodes.length > 0 ? depositNodes[0].id : null;
                  const depositData = depositNodes.length > 0 ? (depositNodes[0].data as NodeData) : undefined;
                  const inputCoin =
                    pipePath?.assetIn ||
                    getRunStepFieldValue(runModeValues, depositStepId || '', 'tokenA', depositData || {}) ||
                    'USDC';

                  const swapStepId = swapNodes.length > 0 ? swapNodes[0].id : null;
                  const swapData = swapNodes.length > 0 ? (swapNodes[0].data as NodeData) : undefined;
                  const lendStepId = lendNodes.length > 0 ? lendNodes[0].id : null;
                  const lendData = lendNodes.length > 0 ? (lendNodes[0].data as NodeData) : undefined;
                  const outputCoin =
                    pipePath?.assetOut ||
                    getRunStepFieldValue(runModeValues, swapStepId || '', 'coinB', swapData || {}) ||
                    getRunStepFieldValue(runModeValues, lendStepId || '', 'coinB', lendData || {}) ||
                    lendData?.toCoin ||
                    inputCoin;

                  const inputAmount = parseFloat(
                    getRunStepFieldValue(runModeValues, depositStepId || '', 'amount', depositData || {}) || '0'
                  ) || 0;
                  
                  const outputAmountNum = pipePath
                    ? calculatePipelineNetReceiveEstimate(
                        inputAmount,
                        pipePath.hops,
                        coinPrices,
                        estimateSlippagePct,
                      )
                    : calculateNetReceiveEstimate(
                        inputAmount,
                        inputCoin || "USDC",
                        outputCoin || inputCoin || "USDC",
                        coinPrices,
                        estimateSlippagePct,
                        totalCost,
                      );
                  
                  const formattedInputAmount = formatAmount(inputAmount, inputCoin);
                  const formattedOutputAmount = formatAmount(outputAmountNum, outputCoin || inputCoin);
                  
                  return (
                    <div className="strategy-modal-io-section">
                      <div className="strategy-modal-io-content">
                        <div className="strategy-modal-io-inputs">
                          <div className="strategy-modal-io-title">Input</div>
                          <div className="strategy-modal-io-items">
                            <div className="strategy-modal-io-item">
                              <span className="strategy-modal-io-coin">{inputCoin}</span>
                              <span className="strategy-modal-io-amount">{formattedInputAmount}</span>
                            </div>
                          </div>
                        </div>
                        <div className="strategy-modal-io-arrow">→</div>
                        <div className="strategy-modal-io-outputs">
                          <div className="strategy-modal-io-title">Output (est.)</div>
                          <div className="strategy-modal-io-items">
                            <div className="strategy-modal-io-item">
                              <span className="strategy-modal-io-coin">{outputCoin}</span>
                              <span className="strategy-modal-io-amount">{formattedOutputAmount}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
                
                {/* Steps Section for Run Mode */}
                <div className="strategy-modal-steps-section">
                  <div className="strategy-modal-steps-header">
                    <span className="strategy-modal-steps-label">Steps ({displayStepNodes.length})</span>
                  </div>
                  {displayStepNodes.length > 0 && (
                    <div className="strategy-steps-list">
                      {displayStepNodes.map((node, index) => {
                        const nodeData = node.data as NodeData;
                        
                        const tags = getStepTags(nodeData, true);
                        
                        const stepId = node.id;
                        
                        const handleMyWallet = () => {
                          const walletAddress = resolveWalletAddress();
                          
                          if (walletAddress) {
                            setRunModeValues(prev => ({
                              ...prev,
                              [stepId]: {
                                ...prev[stepId],
                                address: walletAddress
                              }
                            }));
                            showToast('Wallet address filled successfully', 'success');
                          } else {
                            showToast('No wallet connected. Please connect a wallet first.', 'error');
                          }
                        };
                        
                        return (
                          <div key={node.id} className="strategy-step-item">
                            <div className="strategy-step-number">{index + 1}</div>
                            <div className="strategy-step-content">
                              <div className="strategy-step-title">{nodeData?.label || `Step ${index + 1}`}</div>
                              {getStepHint(nodeData, strategyCoin) && (
                                <div className="strategy-step-hint">{getStepHint(nodeData, strategyCoin)}</div>
                              )}
                              <div className="strategy-step-details">
                                {tags.map((tag, idx) => (
                                    <div key={idx} className="strategy-step-input-wrapper">
                                      {tag.readOnly ? (
                                        <div className="strategy-step-readonly" title="Determined by the swap output">
                                          <span className="strategy-step-readonly-label">{tag.label}</span>
                                          <span className="strategy-step-readonly-value">{tag.value}</span>
                                        </div>
                                      ) : tag.options ? (
                                        <select
                                          className="strategy-step-select"
                                          value={getRunStepFieldValue(runModeValues, stepId, tag.field, nodeData)}
                                          onChange={(e) => {
                                            setRunModeValues(prev => ({
                                              ...prev,
                                              [stepId]: {
                                                ...prev[stepId],
                                                [tag.field]: e.target.value
                                              }
                                            }));
                                          }}
                                        >
                                          <option value="">{tag.label}</option>
                                          {tag.field === 'repeatMode' ? (
                                            <>
                                              <option value="until_funds">Until funds end</option>
                                              <option value="count">N times</option>
                                            </>
                                          ) : (
                                            tag.options.map(opt => (
                                              <option
                                                key={opt}
                                                value={opt}
                                                disabled={tag.disabledOptions?.includes(opt)}
                                              >
                                                {opt}
                                              </option>
                                            ))
                                          )}
                                        </select>
                                      ) : (
                                        <input
                                          type="text"
                                          className="strategy-step-input"
                                          placeholder={tag.label}
                                          // Once the user has touched this field, honour their value verbatim —
                                          // including empty — so backspacing to clear doesn't snap back to the
                                          // template default. Only fall back to the default before any edit.
                                          value={
                                            runModeValues[stepId]?.[tag.field] ??
                                            getRunStepFieldValue(runModeValues, stepId, tag.field, nodeData)
                                          }
                                          onChange={(e) => {
                                            setRunModeValues(prev => ({
                                              ...prev,
                                              [stepId]: {
                                                ...prev[stepId],
                                                [tag.field]: e.target.value
                                              }
                                            }));
                                          }}
                                        />
                                      )}
                                    </div>
                                  ))}
                                {nodeData?.type === 'withdraw' && (
                                  <button
                                    className="strategy-step-my-wallet-btn"
                                    onClick={handleMyWallet}
                                    type="button"
                                  >
                                    My Wallet
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className={`strategy-modal-aside${isRunMode ? ' strategy-modal-aside--run-only' : ''}`}>
              {/* Run Configuration Panel */}
              <div className={`strategy-modal-run-config ${isFading ? 'fade-out' : 'fade-in'} ${isExecuting ? 'darkened' : ''}`}>
                <h3 className="strategy-run-config-title">Run Configuration</h3>
                
                <div className="strategy-run-stats">
                  <div className="strategy-run-stat-item">
                    <span className="strategy-run-stat-label">Execution Time</span>
                    <span className="strategy-run-stat-value">{executionTime} sec</span>
                  </div>
                  <div className="strategy-run-stat-item">
                    <span className="strategy-run-stat-label">Execution Window</span>
                    <span className="strategy-run-stat-value strategy-run-window-inline">
                      <select
                        className="strategy-run-duration-select-inline"
                        value={runDuration}
                        onChange={(e) => setRunDuration(e.target.value)}
                      >
                        {WINDOW_OPTIONS.map(([value, , label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <span>${windowFeeUsd(runDurationHours).toFixed(2)}</span>
                    </span>
                  </div>
                  <div className="strategy-run-stat-item">
                    <span className="strategy-run-stat-label">Arming Fee</span>
                    <span className="strategy-run-stat-value">
                      ${baseFee.toFixed(2)}
                    </span>
                  </div>
                  <div className="strategy-run-stat-item">
                    <span className="strategy-run-stat-label">Deposit Used</span>
                    <span className="strategy-run-stat-value">
                      {(() => {
                        const depositNodes = modalStrategyNodes.filter(node => (node.data as NodeData)?.type === 'deposit');
                        const depositStepId = depositNodes.length > 0 ? depositNodes[0].id : null;
                        const depositData = depositNodes.length > 0 ? (depositNodes[0].data as NodeData) : undefined;
                        const inputAmount = getRunStepFieldValue(runModeValues, depositStepId || '', 'amount', depositData || {}) || '0';
                        const inputCoinLocal = getRunStepFieldValue(runModeValues, depositStepId || '', 'tokenA', depositData || {}) || 'USDC';
                        const inputAmountNum = parseFloat(inputAmount) || 0;
                        const formattedInputAmount = formatAmount(inputAmountNum, inputCoinLocal);
                        return `${formattedInputAmount} ${inputCoinLocal}`;
                      })()}
                    </span>
                  </div>
                </div>
              </div>

              </div>
            </React.Fragment>
          ) : (
            <React.Fragment>
              <div className="strategy-modal-info">
                <div className="strategy-modal-categories">
                  {(() => {
                    const allChains = new Map<string, { name: string; isActive: boolean }>();
                    
                    selectedStrategy.chains.forEach((chain: string) => {
                      const normalized = chain.toLowerCase();
                      if (!allChains.has(normalized)) {
                        const isActive = selectedStrategy.name === 'Limit Order' 
                          ? normalized === 'base' 
                          : false;
                        allChains.set(normalized, {
                          name: chain.charAt(0).toUpperCase() + chain.slice(1),
                          isActive
                        });
                      }
                    });
                    
                    selectedStrategy.networks.forEach((network: string) => {
                      const normalized = network.toLowerCase();
                      if (!allChains.has(normalized)) {
                        const isActive = selectedStrategy.name === 'Limit Order' 
                          ? normalized === 'base' 
                          : false;
                        allChains.set(normalized, {
                          name: network,
                          isActive
                        });
                      } else {
                        const existing = allChains.get(normalized)!;
                        if (selectedStrategy.name === 'Limit Order') {
                          existing.isActive = normalized === 'base';
                        }
                      }
                    });
                    
                    const sortedChains = Array.from(allChains.values()).sort((a, b) => {
                      if (a.isActive && !b.isActive) return -1;
                      if (!a.isActive && b.isActive) return 1;
                      return 0;
                    });
                    
                    return sortedChains.map((chain, idx) => (
                      <span 
                        key={idx} 
                        className={`strategy-modal-category-badge ${!chain.isActive ? 'inactive' : ''}`}
                      >
                        {chain.name}
                      </span>
                    ));
                  })()}
                </div>
                <p className="strategy-modal-description">{selectedStrategy.description}</p>
                
                {/* Input/Output Section */}
                {modalStrategyNodes.length > 0 && (() => {
                  const depositNodes = modalStrategyNodes.filter(node => (node.data as NodeData)?.type === 'deposit');
                  const strategyNodes = modalStrategyNodes.filter(node => (node.data as NodeData)?.type === 'strategy');
                  
                  const inputCoin = depositNodes.length > 0 && (depositNodes[0].data as NodeData)?.coin 
                    ? (depositNodes[0].data as NodeData).coin 
                    : 'USDC';
                  
                  return (
                    <div className="strategy-modal-io-section">
                      <div className="strategy-modal-io-content">
                        <div className="strategy-modal-io-inputs">
                          <div className="strategy-modal-io-title">Input</div>
                          <div className="strategy-modal-io-items">
                            <div className="strategy-modal-io-item">
                              <span className="strategy-modal-io-coin">Coin A</span>
                            </div>
                          </div>
                        </div>
                        <div className="strategy-modal-io-arrow">→</div>
                        <div className="strategy-modal-io-outputs">
                          <div className="strategy-modal-io-title">Output</div>
                          <div className="strategy-modal-io-items">
                            <div className="strategy-modal-io-item">
                              <span className="strategy-modal-io-coin">Token B</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
                
                <div className="strategy-modal-steps-section">
                  <div className="strategy-modal-steps-header">
                    <span className="strategy-modal-steps-label">Steps ({displayStepNodes.length})</span>
                  </div>
                  {displayStepNodes.length > 0 && (
                    <div className="strategy-steps-list">
                      {displayStepNodes.map((node, index) => {
                        const nodeData = node.data as NodeData;
                        
                        const tags = getStepTags(nodeData, false);
                        
                        return (
                          <div key={node.id} className="strategy-step-item">
                            <div className="strategy-step-number">{index + 1}</div>
                            <div className="strategy-step-content">
                              <div className="strategy-step-title">{nodeData?.label || `Step ${index + 1}`}</div>
                              {getStepHint(nodeData, strategyCoin) && (
                                <div className="strategy-step-hint">{getStepHint(nodeData, strategyCoin)}</div>
                              )}
                              <div className="strategy-step-details">
                                {tags.map((tag, idx) => (
                                  <span key={idx} className={`strategy-step-tag strategy-step-${tag.label.toLowerCase().replace(/\s+/g, '-')}`}>
                                    {tag.label}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              
              <div className="strategy-modal-preview">
                <h3 className="strategy-preview-title">Strategy Preview</h3>
                <div className="strategy-preview-flow">
                  <StrategyPreviewFlow
                    nodes={modalStrategyNodes}
                    edges={modalStrategyEdges}
                    flowKey={flowKey}
                    isLoading={isFlowLoading}
                  />
                </div>
              </div>
            </React.Fragment>
          )}
        </div>
        
        <div className={`strategy-modal-actions ${isFading ? 'fade-out' : 'fade-in'}`}>
          <button 
            className={`strategy-modal-btn strategy-modal-btn-run ${!isWalletConnected ? 'disabled' : ''}`}
            onClick={handleExecute}
            disabled={isExecuting}
          >
            {isExecuting ? (
              <svg className="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeLinecap="round" />
              </svg>
            ) : !isWalletConnected ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12v-2a5 5 0 0 0-5-5H8a5 5 0 0 0-5 5v2" />
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v6m0 6v6" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            )}
            {isExecuting ? 'Processing...' : (!isWalletConnected ? 'Connect Wallet' : (isRunMode ? 'Pay & Run' : 'Run'))}
          </button>
          <button 
            className="strategy-modal-btn strategy-modal-btn-edit"
            onClick={handleEdit}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit
          </button>
          <button 
            className="strategy-modal-btn strategy-modal-btn-save"
            onClick={handleSave}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            Save
          </button>
        </div>
        </div>
      </div>
      )}
    </>,
    document.body
  );
}
