"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  Connection,
  Node,
  Edge,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  NodeChange,
  EdgeChange,
  useReactFlow,
  useStore,
  useUpdateNodeInternals,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import "./Build.css";
import "./build-dashboard.css";
import BuildNav from "./BuildNav";
import { type BuildChatMessage } from "./BuildAiPrompt";
import { BuildWidgetSection } from "@/components/landing/BuildWidgetSection";
import { BuildHeroBand } from "@/components/landing/BuildHeroBand";
import { DashboardCustomizeProvider } from "@/components/landing/dashboard-customize-context";
import { RunningStrategiesProvider } from "@/components/widgets/running-strategies-context";
import BuildPageFooter from "./BuildPageFooter";
import BuildNodeContextMenu from "./BuildNodeContextMenu";
import BuildSimToast from "./BuildSimToast";
import DetailsModal from "../Discover/DetailsModal";
import "../Discover/Discover.css";
import {
  initializeDiscoverStrategies,
  initializeLimitOrderStrategy,
  loadStrategyGraphByName,
  type StrategyMetadata,
} from "../Discover/strategies";
import { useCanvasSimulation, type SimHighlightStatus } from "./useCanvasSimulation";
import { BuildFlowContextProvider, FLOW_NODE_TYPES } from "./flowNodeTypes";
import { useRepeatDropHandlers } from "./RepeatDropHandler";
import {
  createRepeatGroupNode,
  getRepeatChildren,
  isRepeatGroupNode,
  REPEAT_BODY_OFFSET_X,
  REPEAT_BODY_OFFSET_Y,
  REPEAT_CHILD_ESTIMATE,
  resolveRepeatSize,
  syncRepeatGroups,
} from "../../../lib/repeatGraph";
import { strategyKindFromNodes } from "../../../lib/graphRunPlan";
import {
  defaultSideForKind,
  resolveLoopIntervalSeconds,
  resolveScheduleStartDelaySeconds,
  normalizeStrategyKind,
  buildStrategyPayload,
  validateStrategyFields,
  resolvePositionPct,
} from "../../../lib/strategySpec";
import { layoutStrategyNodes, getModalStepNodes, randomBuilderNodePosition } from "../../../lib/builderLayout";
import { stripNodeWrapperStyle } from "../../../lib/builderNodeStyle";
import { formatGraphForPreview } from "../../../lib/repeatGraph";
import { buildRunModeValuesFromNodes } from "../../../lib/runModeValues";
import {
  applySwapToWithdrawLink,
  clearOutputLinksForRemovedEdges,
  resolveWithdrawAmount,
  syncLinkedWithdrawFromSwap,
} from "../../../lib/graphLinks";
import { processBuilderTurn } from "../../../builder_agent";
import type { BuilderAgentSession } from "../../../builder_agent";
import { activeTokensForChain, builderChainProfile, isDexActive } from "../../../builder_agent/blocks";
import { readStoredHomeChainId } from "@/lib/chains/homeChains";
import { useEthPrice } from "@/lib/useEthPrice";
import { showAppToast } from "@/lib/appToast";
import { getSelectedChainId, getTokens, getZkWithdrawRecipient, getNetwork, NATIVE_TOKEN, setSelectedChainId } from "../../../lib/networks";
import { validateVaultBridgeBlock } from "../../../lib/v3/vaultBridgeLeg";
import { executeVaultBridgeLeg } from "../../../lib/v3/executeVaultBridgeLeg";
import { withdrawNodeTitle } from "../../../lib/bridge/hub";
import { peekActiveNoteCursor } from "../../../lib/v3/noteCursorSession";
import { resolveWalletAddress } from "../../../lib/walletAddress";
import { submitEncryptedStrategy } from "../../../lib/strategySubmit";
import { generateZKData, type TokenInfo } from "../../../lib/zkHandler";
import { buildTwapLegs, buildGridLegs, submitSplitOnChain, resolveSwapPool, collectArmingFee, depositForSplit, clampSlippageBps, twapEncryptLeg, gridEncryptLeg } from "../../../lib/multiLegBuilder";
import { buildV3Multi, v3StrategiesLive, v3SwapParams } from "../../../lib/v3/strategyOrchestrateV3";
import { createExecutorSubmitV3 } from "../../../lib/v3/executorSubmitV3";
import { armingChargeUsd } from "../../../lib/feeModel";
import { ethers } from "ethers";
import { getOrCreateClientKey } from "../../../lib/fhe";
import { getSigner } from "../../../lib/nexus";
import { reserveStrategyNotes } from "../../../lib/strategyNoteReservation";
import { validateRecipientAddress, chainLabelToId, createDefaultLimitOrderTree } from "./BuildNodes";
import {
  resolveLimitOrderConditionTree,
  validatePriceConditionTreeRaw,
} from "@/lib/limitOrderTree";

/** First ETH price bound in the tree that is wildly off the live price (likely a malformed
 * strategy that would fire on the first tick), or null if every bound looks sane. A 20× band
 * still allows legitimate far-out limits (e.g. ≤$1000 or ≥$3000 vs ~$1800). */
function implausibleEthBound(tree: unknown, ethUsd: number | null | undefined): number | null {
  if (!ethUsd || ethUsd <= 0 || !tree || typeof tree !== "object") return null;
  const node = tree as { op?: string; asset?: string; bound?: number; conditions?: unknown[] };
  if (node.op === "LEAF") {
    const bound = Number(node.bound);
    if ((node.asset || "").toUpperCase() === "ETH" && Number.isFinite(bound) &&
        (bound < ethUsd / 20 || bound > ethUsd * 20)) {
      return bound;
    }
    return null;
  }
  for (const child of node.conditions ?? []) {
    const bad = implausibleEthBound(child, ethUsd);
    if (bad !== null) return bad;
  }
  return null;
}

interface BuildProps {
  isLoaded?: boolean;
  nodes: Node[];
  edges: Edge[];
  setNodes: (nodes: Node[] | ((nodes: Node[]) => Node[])) => void;
  setEdges: (edges: Edge[] | ((edges: Edge[]) => Edge[])) => void;
  currentFileName: string;
  setCurrentFileName: (name: string) => void;
  savedScenes: Array<{ name: string; nodes: Node[]; edges: Edge[] }>;
  setSavedScenes: (scenes: Array<{ name: string; nodes: Node[]; edges: Edge[] }> | ((scenes: Array<{ name: string; nodes: Node[]; edges: Edge[] }>) => Array<{ name: string; nodes: Node[]; edges: Edge[] }>)) => void;
  setViewMode?: (mode: 'blueprint' | 'run' | 'discover') => void;
  runningStrategies?: Map<string, { startTime: number; isRunning: boolean; loop: boolean }>;
  setRunningStrategies?: (strategies: Map<string, { startTime: number; isRunning: boolean; loop: boolean }> | ((prev: Map<string, { startTime: number; isRunning: boolean; loop: boolean }>) => Map<string, { startTime: number; isRunning: boolean; loop: boolean }>)) => void;
}

interface NodeContextMenuState {
  nodeId: string;
  x: number;
  y: number;
}

function BlueprintFlowViewport({ nodes }: { nodes: Node[] }) {
  const { fitView, setCenter } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const flowDomNode = useStore((state) => state.domNode);
  const nodeStructureKey = nodes.map((node) => node.id).join("|");

  const refreshNodeMeasurements = useCallback(() => {
    nodes.forEach((node) => updateNodeInternals(node.id));
  }, [nodes, updateNodeInternals]);

  const alignView = useCallback(() => {
    refreshNodeMeasurements();
    if (nodes.length === 0) {
      void setCenter(0, 0, { zoom: 0.85, duration: 0 });
      return;
    }
    void fitView({ padding: 0.35, duration: 200, maxZoom: 0.8 });
  }, [nodes.length, setCenter, fitView, refreshNodeMeasurements]);

  const remeasureNodes = useCallback(() => {
    refreshNodeMeasurements();
  }, [refreshNodeMeasurements]);

  useEffect(() => {
    alignView();
    const raf = requestAnimationFrame(alignView);
    const t1 = window.setTimeout(alignView, 80);
    const t2 = window.setTimeout(alignView, 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [nodeStructureKey, nodes.length, alignView]);

  useEffect(() => {
    const onResize = () => alignView();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [alignView]);

  useEffect(() => {
    const queries = [1600, 1440, 1280].map((width) =>
      window.matchMedia(`(max-width: ${width}px)`),
    );
    const onBreakpointChange = () => alignView();
    queries.forEach((query) => query.addEventListener("change", onBreakpointChange));
    return () => {
      queries.forEach((query) => query.removeEventListener("change", onBreakpointChange));
    };
  }, [alignView]);

  useEffect(() => {
    if (!flowDomNode) return;
    const observer = new ResizeObserver(() => remeasureNodes());
    observer.observe(flowDomNode);
    return () => observer.disconnect();
  }, [flowDomNode, remeasureNodes]);

  return null;
}

function sortNodesParentsFirst(nds: Node[]): Node[] {
  const roots = nds.filter((n) => !n.parentId);
  const children = nds.filter((n) => n.parentId);
  return [...roots, ...children];
}

function sortAndSyncRepeat(nodes: Node[]): Node[] {
  return sortNodesParentsFirst(syncRepeatGroups(nodes));
}

interface BlueprintFlowProps {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (params: Connection) => void;
  onNodeContextMenu: (event: React.MouseEvent, node: Node) => void;
  onPaneContextMenu: (event: React.MouseEvent | MouseEvent) => void;
  onPaneClick: () => void;
  onMoveStart: () => void;
  onNodesDelete: (nodesToDelete: Node[]) => void;
  updateNodeData: (nodeId: string, field: string, value: string) => void;
  tokens: string[];
  isTokenActive: (token: string) => boolean;
  simHighlight?: Record<string, SimHighlightStatus>;
  simShakingId?: string | null;
  simExiting?: boolean;
}

function BlueprintFlow({
  setNodes,
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeContextMenu,
  onPaneContextMenu,
  onPaneClick,
  onMoveStart,
  onNodesDelete,
  updateNodeData,
  tokens,
  isTokenActive,
  simHighlight,
  simShakingId,
  simExiting,
}: BlueprintFlowProps & {
  setNodes: BuildProps['setNodes'];
}) {
  const wrappedSync = useCallback(
    (nds: Node[]) => sortAndSyncRepeat(nds),
    []
  );

  const { onNodeDrag, onNodeDragStop } = useRepeatDropHandlers(setNodes, wrappedSync);

  const flowContextValue = useMemo(
    () => ({ updateNodeData, tokens, isTokenActive, simHighlight, simShakingId, simExiting }),
    [updateNodeData, tokens, isTokenActive, simHighlight, simShakingId, simExiting]
  );

  const onFlowInit = useCallback(
    (instance: ReactFlowInstance) => {
      if (nodes.length === 0) {
        void instance.setCenter(0, 0, { zoom: 0.85, duration: 0 });
      }
    },
    [nodes.length]
  );

  // Multi-leg strategies (Loop/DCA/TWAP/Range) always re-deposit each swap output into the vault
  // (output_mode='vault'); there is no per-leg external withdrawal, so the WITHDRAW block only
  // misleads. Hide it (and its edges) at render time — state is untouched, so save/submit still work
  // (assetOut comes from the swap node, recipient from the connected wallet) — and reflow its parent
  // loop group so no empty slot is left behind.
  const { displayNodes, displayEdges } = useMemo(() => {
    const kind = strategyKindFromNodes(nodes);
    const isMultiLeg = kind === 'Loop' || kind === 'DCA' || kind === 'TWAP' || kind === 'Range';
    const withdrawNode = nodes.find((n) => n.data.type === 'withdraw');
    if (!isMultiLeg || !withdrawNode) return { displayNodes: nodes, displayEdges: edges };
    const parentId = withdrawNode.parentId;

    // The loop box keeps its min width (it must fit the "Until funds end / EACH / Hours" header), so
    // after hiding WITHDRAW the lone SWAP would sit left-aligned with dead space. Recompute the box
    // and horizontally CENTER the remaining visible children within it (positions are parent-relative).
    const widthOf = (c: Node) =>
      c.measured?.width ?? (Number(c.style?.width) || REPEAT_CHILD_ESTIMATE.width);
    let groupWidth = 0;
    let groupHeight = 0;
    let childDx = 0;
    const visibleIds = new Set<string>();
    if (parentId) {
      const parent = nodes.find((n) => n.id === parentId);
      const visible = getRepeatChildren(nodes, parentId).filter((c) => c.id !== withdrawNode.id);
      visible.forEach((c) => visibleIds.add(c.id));
      if (parent && visible.length) {
        const size = resolveRepeatSize(parent, visible);
        groupWidth = size.width;
        groupHeight = size.height;
        const minX = Math.min(...visible.map((c) => c.position.x));
        const maxX = Math.max(...visible.map((c) => c.position.x + widthOf(c)));
        const targetMinX = Math.max(REPEAT_BODY_OFFSET_X, (groupWidth - (maxX - minX)) / 2);
        childDx = targetMinX - minX;
      }
    }

    const dn = nodes.map((n) => {
      if (n.id === withdrawNode.id) return { ...n, hidden: true };
      if (parentId && n.id === parentId && groupWidth) {
        return {
          ...n,
          style: { ...n.style, width: groupWidth, height: groupHeight },
          data: { ...n.data, childCount: visibleIds.size },
        };
      }
      if (visibleIds.has(n.id) && childDx) {
        return { ...n, position: { ...n.position, x: n.position.x + childDx } };
      }
      return n;
    });
    const de = edges.map((e) =>
      e.source === withdrawNode.id || e.target === withdrawNode.id ? { ...e, hidden: true } : e
    );
    return { displayNodes: dn, displayEdges: de };
  }, [nodes, edges]);

  return (
    <BuildFlowContextProvider value={flowContextValue}>
    <ReactFlow
      nodes={displayNodes}
      edges={displayEdges}
      onInit={onFlowInit}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeContextMenu={onNodeContextMenu}
      onPaneContextMenu={onPaneContextMenu}
      onPaneClick={onPaneClick}
      onMoveStart={onMoveStart}
      onNodesDelete={onNodesDelete}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      minZoom={0.1}
      maxZoom={2}
      deleteKeyCode={['Backspace', 'Delete']}
      nodesDraggable={true}
      nodesConnectable={true}
      elementsSelectable={true}
      panOnDrag
      panOnScroll={false}
      zoomOnScroll
      zoomOnPinch
      zoomOnDoubleClick={false}
      selectNodesOnDrag={false}
      preventScrolling
      autoPanOnNodeDrag={false}
      nodeTypes={FLOW_NODE_TYPES}
      defaultEdgeOptions={{
        style: { stroke: 'rgba(255, 255, 255, 0.3)', strokeWidth: 2 },
        type: 'smoothstep',
      }}
      proOptions={{ hideAttribution: true }}
    >
      <BlueprintFlowViewport nodes={nodes} />
    </ReactFlow>
    </BuildFlowContextProvider>
  );
}

export default function Build({
  isLoaded = true,
  nodes,
  edges,
  setNodes,
  setEdges,
  currentFileName,
  setCurrentFileName,
  savedScenes,
  setSavedScenes,
  setViewMode,
  runningStrategies,
  setRunningStrategies,
}: BuildProps) {
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null);
  const [showRunModal, setShowRunModal] = useState(false);
  // Post-submission confirmation toast — same look/lifecycle as the smoke-test toast.
  const [submitToast, setSubmitToast] = useState<string | null>(null);
  const [submitToastExiting, setSubmitToastExiting] = useState(false);
  const submitToastTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const dismissSubmitToast = useCallback(() => {
    for (const t of submitToastTimers.current) clearTimeout(t);
    submitToastTimers.current = [];
    setSubmitToast(null);
    setSubmitToastExiting(false);
  }, []);

  const showSubmitToast = useCallback((message: string) => {
    for (const t of submitToastTimers.current) clearTimeout(t);
    submitToastTimers.current = [];
    setSubmitToast(message);
    setSubmitToastExiting(false);
    const hold = setTimeout(() => {
      setSubmitToastExiting(true);
      const fade = setTimeout(() => {
        setSubmitToast(null);
        setSubmitToastExiting(false);
      }, 900);
      submitToastTimers.current.push(fade);
    }, 7000);
    submitToastTimers.current.push(hold);
  }, []);
  const [runModalNodes, setRunModalNodes] = useState<Node[]>([]);
  const [runModalEdges, setRunModalEdges] = useState<Edge[]>([]);
  const [runFlowKey, setRunFlowKey] = useState(0);
  const [isRunMode, setIsRunMode] = useState(false);
  const [runModeValues, setRunModeValues] = useState<Record<string, Record<string, string>>>({});
  const [runDuration, setRunDuration] = useState('1h');
  const [isFading, setIsFading] = useState(false);
  const [showSuccessNotification, setShowSuccessNotification] = useState(false);
  const [isBuilderAgentLoading, setIsBuilderAgentLoading] = useState(false);

  // The run modal (DetailsModal.handleExecute) flips showSuccessNotification on a successful
  // strategy submission; surface it as the canvas toast (Discover renders its own equivalent).
  useEffect(() => {
    if (showSuccessNotification) {
      showSubmitToast('Strategy initiated, check activity log');
    }
  }, [showSuccessNotification, showSubmitToast]);
  const [builderSession, setBuilderSession] = useState<BuilderAgentSession | null>(null);
  const [builderMessages, setBuilderMessages] = useState<BuildChatMessage[]>([]);
  const [chatFocus, setChatFocus] = useState(false);
  const [buildViewActive, setBuildViewActive] = useState(false);
  const [widgetsVisible, setWidgetsVisible] = useState(() => {
    if (typeof window === "undefined") return true;
    return !window.matchMedia("(max-width: 768px)").matches;
  });
  const [builderPrompt, setBuilderPrompt] = useState("");
  const pageLayoutRef = useRef<HTMLDivElement>(null);
  const ethUsd = useEthPrice();
  const tokens = ['ETH', 'USDC', 'SOL', 'jlUSDC', 'JitoSOL', 'USDT', 'WBTC', 'XMR'];

  useEffect(() => {
    if (chatFocus) setWidgetsVisible(false);
  }, [chatFocus]);

  const handleChatActiveChange = useCallback((active: boolean) => {
    setChatFocus(active);
  }, []);

  const handleToggleWidgets = useCallback(() => {
    setWidgetsVisible((visible) => {
      const next = !visible;
      if (next) {
        setBuildViewActive(false);
        requestAnimationFrame(() => {
          if (pageLayoutRef.current) pageLayoutRef.current.scrollTop = 0;
        });
      } else if (nodes.length > 0) {
        setBuildViewActive(true);
      }
      return next;
    });
  }, [nodes.length]);

  const hasCanvasContent = nodes.length > 0;
  const canvasExpanded =
    !widgetsVisible && (chatFocus || buildViewActive || hasCanvasContent);

  useEffect(() => {
    if (!widgetsVisible && nodes.length > 0) {
      setBuildViewActive(true);
    }
  }, [widgetsVisible, nodes.length]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("build-view-expanded", { detail: canvasExpanded }));
    document.body.classList.toggle("build-view-expanded", canvasExpanded);
    return () => {
      document.body.classList.remove("build-view-expanded");
    };
  }, [canvasExpanded]);
  
  useEffect(() => {
    const onCustomizeOpen = () => {
      setWidgetsVisible(true);
      setBuildViewActive(false);
    };
    window.addEventListener("build-dashboard-customize-open", onCustomizeOpen);
    return () => window.removeEventListener("build-dashboard-customize-open", onCustomizeOpen);
  }, []);

  // Lets DashboardTour force widgets on/off between its "node canvas" and "widgets" spotlight stops.
  useEffect(() => {
    const onTourWidgetsVisible = (e: Event) => {
      const visible = (e as CustomEvent<boolean>).detail;
      setWidgetsVisible(visible);
      setBuildViewActive(!visible);
    };
    window.addEventListener("siphon:tour-widgets-visible", onTourWidgetsVisible);
    return () => window.removeEventListener("siphon:tour-widgets-visible", onTourWidgetsVisible);
  }, []);

  useEffect(() => {
    initializeLimitOrderStrategy();
    initializeDiscoverStrategies();
  }, []);
  
  // Active tokens follow the builder chain profile (Solana → SOL/USDC; EVM → ETH/USDC).
  // Tracked in state: reading the chain once left the coins on the old chain after a switch.
  const [selectedChain, setSelectedChain] = useState(getSelectedChainId);
  const [homeChainId, setHomeChainId] = useState<string | null>(() => readStoredHomeChainId());
  useEffect(() => {
    const onChain = () => setSelectedChain(getSelectedChainId());
    const onHome = () => setHomeChainId(readStoredHomeChainId());
    window.addEventListener('siphon:chainChanged', onChain);
    window.addEventListener('siphon:homeChainChanged', onHome);
    return () => {
      window.removeEventListener('siphon:chainChanged', onChain);
      window.removeEventListener('siphon:homeChainChanged', onHome);
    };
  }, []);
  const activeTokens = activeTokensForChain({ chainId: selectedChain, homeChainId });
  const isTokenActive = (token: string) => activeTokens.includes(token);

  const {
    simHighlight,
    simShakingId,
    simToast,
    simExiting,
    isSimulating,
    runSimulation,
    dismissToast,
  } = useCanvasSimulation(nodes, edges);
  
  // Normalize node to ensure it has all required properties
  const normalizeNode = useCallback((node: Node): Node => {
    const normalized = stripNodeWrapperStyle(node);
    return {
      ...normalized,
      type: normalized.type || (normalized.data?.type === 'repeatGroup' ? 'repeatGroup' : 'custom'),
      draggable: normalized.draggable !== undefined ? normalized.draggable : true,
      selectable: normalized.selectable !== undefined ? normalized.selectable : true,
      connectable: normalized.connectable !== undefined ? normalized.connectable : true,
      sourcePosition: normalized.sourcePosition || Position.Right,
      targetPosition: normalized.targetPosition || Position.Left,
      extent: normalized.extent ?? (normalized.parentId ? 'parent' : undefined),
    };
  }, []);

  const syncRepeatState = useCallback(
    (nds: Node[]) => sortAndSyncRepeat(nds.map(stripNodeWrapperStyle)),
    [],
  );

  const onLoadStrategyTemplate = useCallback((strategyName: string) => {
    const graph = loadStrategyGraphByName(strategyName);
    if (!graph.nodes.length) return;
    const normalizedNodes = sortAndSyncRepeat(graph.nodes.map(normalizeNode));
    setNodes(normalizedNodes);
    setEdges(graph.edges);
    setCurrentFileName(`${strategyName.toLowerCase().replace(/\s+/g, '-')}.io`);
    setBuilderSession(null);
    setBuilderMessages([]);
    setBuilderPrompt("");
    setNodeContextMenu(null);
    setWidgetsVisible(false);
    setBuildViewActive(true);
  }, [setNodes, setEdges, setCurrentFileName, normalizeNode]);

  useEffect(() => {
    const onStrategyPick = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      if (typeof name === "string" && name.trim()) {
        onLoadStrategyTemplate(name);
      }
    };
    window.addEventListener("build-select-strategy-template", onStrategyPick as EventListener);
    return () =>
      window.removeEventListener("build-select-strategy-template", onStrategyPick as EventListener);
  }, [onLoadStrategyTemplate]);

  const buildBlockNode = useCallback((
    type: 'deposit' | 'withdraw' | 'swap' | 'lend' | 'strategy' | 'control' | 'bridge',
    chainOrDexOrStrategy?: string,
    opts?: { parentId?: string; position?: { x: number; y: number }; toChain?: string }
  ): Node => {
    const chainOpts = {
      chainId: getSelectedChainId(),
      homeChainId: readStoredHomeChainId(),
    };
    const resolvedSwapDex =
      type === "swap"
        ? chainOrDexOrStrategy && isDexActive(chainOrDexOrStrategy, chainOpts)
          ? chainOrDexOrStrategy
          : builderChainProfile(chainOpts).preferredDex
        : null;
    const lendVenue =
      type === "lend"
        ? chainOrDexOrStrategy === "jito-enter" || chainOrDexOrStrategy === "jito-exit"
          ? "jito"
          : "jupiter"
        : null;
    const lendAction =
      type === "lend"
        ? chainOrDexOrStrategy === "exit" || chainOrDexOrStrategy === "jito-exit"
          ? "exit"
          : "enter"
        : null;

    let label = '';
    if (type === 'swap') {
      label = resolvedSwapDex ? `Swap on ${resolvedSwapDex}` : 'Swap';
    } else if (type === 'lend') {
      label =
        lendVenue === "jito"
          ? lendAction === "exit"
            ? "Unstake (Jito)"
            : "Stake (Jito)"
          : lendAction === "exit"
            ? "Earn Exit (Jupiter)"
            : "Earn Enter (Jupiter)";
    } else if (type === 'withdraw') {
      label = withdrawNodeTitle(chainOrDexOrStrategy);
    } else if (type === 'bridge') {
      const to = opts?.toChain || chainOrDexOrStrategy || 'Base';
      label = `Bridge → ${to}`;
    } else if (type === 'strategy') {
      label = chainOrDexOrStrategy ? chainOrDexOrStrategy : 'Strategy';
    } else if (type === 'control') {
      label = chainOrDexOrStrategy ? chainOrDexOrStrategy : 'Control';
    } else {
      label = 'Deposit';
    }

    const isControl = type === 'control';
    const controlKind = isControl ? (chainOrDexOrStrategy || '').toLowerCase() : null;
    const isStrategy = type === 'strategy';
    const strategyKind = isStrategy ? normalizeStrategyKind(chainOrDexOrStrategy) : null;
    const blockType = isControl ? 'control' : type;
    const defaultConditionTree = strategyKind === 'Limit Order'
      ? JSON.stringify(createDefaultLimitOrderTree())
      : null;

    const bridgeFrom =
      type === 'bridge'
        ? (getSelectedChainId() === 42161 ? 'Arbitrum' : 'Base')
        : null;
    const bridgeTo =
      type === 'bridge' ? (opts?.toChain || chainOrDexOrStrategy || 'Base') : null;

    return {
      id: `${blockType}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: 'custom',
      position: opts?.position ?? randomBuilderNodePosition(),
      data: {
        label,
        type: isControl ? 'control' : type,
        chain:
          type === 'bridge'
            ? bridgeFrom
            : (type !== 'swap' && type !== 'lend' && type !== 'strategy' && type !== 'control')
              ? (chainOrDexOrStrategy || null)
              : null,
        toChain: bridgeTo,
        dex: type === 'swap' ? resolvedSwapDex : null,
        strategy: isStrategy ? (chainOrDexOrStrategy || null) : null,
        lendAction,
        lendVenue,
        controlKind,
        coin:
          type === 'bridge'
            ? 'USDC'
            : type === 'lend'
              ? lendVenue === 'jito'
                ? lendAction === 'exit'
                  ? 'JitoSOL'
                  : 'SOL'
                : lendAction === 'exit'
                  ? 'jlUSDC'
                  : 'USDC'
              : null,
        amount: null,
        toCoin:
          type === 'lend'
            ? lendVenue === 'jito'
              ? lendAction === 'exit'
                ? 'SOL'
                : 'JitoSOL'
              : lendAction === 'exit'
                ? 'USDC'
                : 'jlUSDC'
            : null,
        toAmount: null,
        wallet: null,
        amountSource: type === 'withdraw' ? 'fixed' : null,
        linkedFromNodeId: null,
        side: isStrategy && strategyKind !== 'Limit Order'
          ? defaultSideForKind(strategyKind!)
          : null,
        useTree: strategyKind === 'Limit Order' ? 'true' : null,
        conditionTree: defaultConditionTree,
        priceGoal: null,
        positionPct: null,
        rangeLow: null,
        rangeHigh: null,
        gridLevels: null,
        sliceCount: null,
        intervalSeconds: null,
        scheduleValue: null,
        scheduleUnit: 'blocks',
        maxSlippageBps: null,
        intervals: null,
        repeatCount: null,
      },
      draggable: true,
      selectable: true,
      connectable: true,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      parentId: opts?.parentId,
      extent: opts?.parentId ? 'parent' : undefined,
      zIndex: opts?.parentId ? 10 : 0,
    };
  }, []);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => syncRepeatState(applyNodeChanges(changes, nds)));
  }, [setNodes, syncRepeatState]);
  
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => {
      const removed = changes
        .filter((c): c is EdgeChange & { type: "remove"; id: string } => c.type === "remove")
        .map((c) => eds.find((e) => e.id === c.id))
        .filter((e): e is Edge => Boolean(e));

      if (removed.length > 0) {
        setNodes((nds) => clearOutputLinksForRemovedEdges(nds, removed));
      }

      return applyEdgeChanges(changes, eds);
    });
  }, [setEdges, setNodes]);
  
  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...params,
            type: "smoothstep",
            style: { stroke: "rgba(255, 255, 255, 0.3)", strokeWidth: 2 },
          },
          eds
        )
      );
      setNodes((nds) => applySwapToWithdrawLink(nds, params));
    },
    [setEdges, setNodes]
  );
  
  const onAddNode = useCallback((type: 'deposit' | 'withdraw' | 'swap' | 'lend' | 'strategy' | 'control' | 'bridge', chainOrDexOrStrategy?: string) => {
    if (type === 'control' && ['repeat', 'loop'].includes((chainOrDexOrStrategy || '').toLowerCase())) {
      setNodes((nds) => sortAndSyncRepeat([...nds, createRepeatGroupNode(randomBuilderNodePosition())]));
      return;
    }
    // Decorative live-price widget — a standalone node (no handles, not part of the run plan).
    if (type === 'control' && (chainOrDexOrStrategy || '').toLowerCase() === 'price') {
      setNodes((nds) => [...nds, {

        id: `priceWidget-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type: 'priceWidget',
        position: randomBuilderNodePosition(),
        data: {},
        draggable: true,
        selectable: true,
        connectable: false,
      }]);
      return;
    }
    // Decorative "rules to remember" reference card — standalone node (no handles, not in the run plan).
    if (type === 'control' && (chainOrDexOrStrategy || '').toLowerCase() === 'rules') {
      setNodes((nds) => [...nds, {
        id: `rules-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type: 'rules',
        position: randomBuilderNodePosition(),
        data: {},
        draggable: true,
        selectable: true,
        connectable: false,
      }]);
      return;
    }

    const newNode = buildBlockNode(type, chainOrDexOrStrategy, {
      position: randomBuilderNodePosition(),
      ...(type === 'bridge' ? { toChain: chainOrDexOrStrategy } : {}),
    });
    
    setNodes((nds) => [...nds, newNode]);
  }, [setNodes, buildBlockNode]);

  const onAddNodeInsideRepeat = useCallback((
    repeatId: string,
    kind: 'swap' | 'strategy' | 'withdraw',
    variant?: string
  ) => {
    const siblings = getRepeatChildren(nodes, repeatId);
    const blockType = kind === 'swap' ? 'swap' : kind === 'withdraw' ? 'withdraw' : 'strategy';
    const child = buildBlockNode(
      blockType,
      variant,
      {
        parentId: repeatId,
        position: {
          x: REPEAT_BODY_OFFSET_X + siblings.length * 210,
          y: REPEAT_BODY_OFFSET_Y + 8,
        },
      }
    );
    const prev = siblings[siblings.length - 1] ?? null;

    setNodes((nds) => {
      let next = sortAndSyncRepeat([...nds, child]);
      if (prev) {
        next = applySwapToWithdrawLink(next, {
          source: prev.id,
          target: child.id,
          sourceHandle: null,
          targetHandle: null,
        });
      }
      return next;
    });

    if (prev) {
      setEdges((eds) => addEdge({
        id: `xy-edge__${prev.id}-${child.id}`,
        source: prev.id,
        target: child.id,
        type: 'smoothstep',
        style: { stroke: 'rgba(147, 197, 253, 0.45)', strokeWidth: 2 },
      }, eds));
    }
  }, [buildBlockNode, nodes, setNodes, setEdges]);
  
  const updateNodeData = useCallback((nodeId: string, field: string, value: string) => {
    setNodes((nds) => {
      let next = nds.map((node) => {
      if (node.id === nodeId) {
        const updatedData = { ...node.data, [field]: value };
        // The withdraw block's title names its destination; keep it in step with the picker.
        if (node.data.type === 'withdraw' && field === 'chain') updatedData.label = withdrawNodeTitle(value);
        
        if (node.data.type === 'swap' && (field === 'amount' || field === 'coin' || field === 'toCoin')) {
          const amount = field === 'amount' ? value : (updatedData.amount || '');
          const coin = field === 'coin' ? value : (updatedData.coin || '');
          const toCoin = field === 'toCoin' ? value : (updatedData.toCoin || '');
          
          if (amount && coin && toCoin) {
            const prices: { [key: string]: number } = { SOL: 192, USDC: 1, USDT: 1, WBTC: 45000, XMR: 120 };
            const pFrom = prices[coin as string] ?? 0;
            const pTo = prices[toCoin as string] ?? 0;
            if (pFrom > 0 && pTo > 0) {
              updatedData.toAmount = (parseFloat(amount as string) * (pFrom / pTo)).toFixed(4);
            } else {
              updatedData.toAmount = null;
            }
          } else {
            updatedData.toAmount = null;
          }
        }

        if (
          node.data.type === 'control' &&
          String(node.data.controlKind || '').toLowerCase() === 'schedule' &&
          (field === 'scheduleValue' || field === 'scheduleUnit')
        ) {
          const delay = resolveScheduleStartDelaySeconds(updatedData);
          if (delay !== undefined) {
            updatedData.scheduleDelaySec = String(delay);
          }
        }

        if (
          isRepeatGroupNode(node) &&
          (field === 'loopIntervalValue' || field === 'loopIntervalUnit')
        ) {
          const sec = resolveLoopIntervalSeconds(updatedData);
          if (sec !== undefined) {
            updatedData.loopIntervalSec = String(sec);
          }
        }

        if (node.data.type === 'withdraw' && field === 'amount') {
          updatedData.amountSource = value.trim() ? 'fixed' : (
            updatedData.linkedFromNodeId ? 'output' : 'fixed'
          );
        }
        
        return { ...node, data: updatedData };
      }
      return node;
    });

      const edited = next.find((n) => n.id === nodeId);
      if (edited?.data?.type === 'swap' && ['amount', 'coin', 'toCoin'].includes(field)) {
        next = syncLinkedWithdrawFromSwap(next, edges, nodeId);
      }
      return next;
    });
  }, [setNodes, edges]);
  
  const onDeleteNode = useCallback((nodeId: string) => {
    setNodes((nds) => {
      const childIds = nds.filter((node) => node.parentId === nodeId).map((node) => node.id);
      const removeIds = new Set([nodeId, ...childIds]);
      setEdges((eds) => eds.filter(
        (edge) => !removeIds.has(edge.source) && !removeIds.has(edge.target)
      ));
      return syncRepeatState(nds.filter((node) => !removeIds.has(node.id)));
    });
    setNodeContextMenu((current) => (current?.nodeId === nodeId ? null : current));
  }, [setNodes, setEdges, syncRepeatState]);

  const onDuplicateNode = useCallback((nodeId: string) => {
    setNodes((nds) => {
      const source = nds.find((node) => node.id === nodeId);
      if (!source) return nds;

      const blockType = (source.data.type as string) || "block";
      const duplicate: Node = stripNodeWrapperStyle({
        ...source,
        id: `${blockType}-${Date.now()}`,
        position: {
          x: source.position.x + 48,
          y: source.position.y + 48,
        },
        data: { ...source.data },
        selected: true,
      });

      return [
        ...nds.map((node) => ({ ...node, selected: false })),
        duplicate,
      ];
    });
  }, [setNodes]);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    event.stopPropagation();
    setNodeContextMenu({
      nodeId: node.id,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    setNodeContextMenu(null);
  }, []);

  const onCanvasContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
  }, []);
  
  const onExecuteStrategy = useCallback(async () => {
    console.log('Executing strategy with nodes:', nodes);

    const depositNode  = nodes.find(n => n.data.type === 'deposit');
    const bridgeNode   = nodes.find(n => n.data.type === 'bridge');
    const strategyNode = nodes.find(n => n.data.type === 'strategy');
    const swapNode     = nodes.find(n => n.data.type === 'swap');
    const withdrawNode = nodes.find(n => n.data.type === 'withdraw');

    if (!depositNode)  { showAppToast('Add a Deposit node with a coin and amount first.', 'error'); return; }
    if (!strategyNode) { showAppToast('Add a Strategy node first.', 'error'); return; }

    if (bridgeNode) {
      const bridgeCheck = validateVaultBridgeBlock({
        fromChain: (bridgeNode.data.chain as string) || (depositNode.data.chain as string),
        toChain: bridgeNode.data.toChain as string,
        symbol: (bridgeNode.data.coin as string) || (depositNode.data.coin as string) || "USDC",
      });
      if (!bridgeCheck.ok) {
        showAppToast(bridgeCheck.error, 'error');
        return;
      }
      showAppToast(
        `Bridge ${bridgeCheck.fromLabel} → ${bridgeCheck.toLabel} runs automatically on this Run (vault↔vault via Li.Fi).`,
        'info',
      );
    }

    const strategyKind = normalizeStrategyKind(strategyNode.data.strategy as string);
    const strategyFields = {
      strategy: strategyKind,
      side: (strategyNode.data.side as string) || defaultSideForKind(strategyKind),
      priceGoal: strategyNode.data.priceGoal as string,
      rangeLow: strategyNode.data.rangeLow as string,
      rangeHigh: strategyNode.data.rangeHigh as string,
      gridLevels: strategyNode.data.gridLevels as string,
      sliceCount: strategyNode.data.sliceCount as string,
      intervalSeconds: strategyNode.data.intervalSeconds as string,
      intervals: strategyNode.data.intervals as string,
      maxSlippageBps: strategyNode.data.maxSlippageBps as string,
      positionPct: strategyNode.data.positionPct as string,
      hlCoin: (strategyNode.data.hlCoin as string) || null,
      hlLeverage: (strategyNode.data.hlLeverage as string) || null,
      hlTakeProfit: (strategyNode.data.hlTakeProfit as string) || null,
      hlStopLoss: (strategyNode.data.hlStopLoss as string) || null,
    };

    // Private Hyperliquid perp — same rails as /perps (ZK + FHE + HYPERLIQUID strategy).
    if (strategyKind === 'Perps') {
      const validation = validateStrategyFields(strategyKind, strategyFields);
      if (!validation.valid) {
        showAppToast(validation.error ?? 'Invalid Perps strategy.', 'error');
        return;
      }
      const margin = parseFloat((depositNode.data.amount as string) || '0');
      if (!(margin > 0)) {
        showAppToast('Enter a USDC margin amount on Deposit.', 'error');
        return;
      }
      const side = (strategyFields.side === 'sell' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT';
      const entryPx = parseFloat(strategyFields.priceGoal || '0');
      try {
        const { submitHyperliquidPerp } = await import('../../../lib/hyperliquidSubmit');
        const result = await submitHyperliquidPerp({
          coin: (strategyFields.hlCoin || 'BTC').toUpperCase(),
          side,
          marginUsd: margin,
          leverage: parseInt(strategyFields.hlLeverage || '3', 10) || 3,
          takeProfitPx: parseFloat(strategyFields.hlTakeProfit || '0') || undefined,
          stopLossPx: parseFloat(strategyFields.hlStopLoss || '0') || undefined,
          trigger: entryPx > 0
            ? { mode: 'threshold', direction: side === 'LONG' ? 'below' : 'above', priceUsd: entryPx }
            : { mode: 'now' },
          cb: {
            onProof: () => showAppToast('Proving spend…', 'info'),
            onEncrypt: () => showAppToast('Encrypting trigger…', 'info'),
          },
        });
        if (!result.success) {
          showAppToast(result.error || 'Perps submit failed', 'error');
          return;
        }
        showAppToast('Private perp strategy armed — track it under Dashboard.', 'success');
      } catch (e: unknown) {
        showAppToast(e instanceof Error ? e.message : 'Perps submit failed', 'error');
      }
      return;
    }

    // No silent default on the asset. `|| 'ETH'` meant an untouched Deposit dropdown ran an ETH
    // strategy the user never chose — the placeholder used to be selectable, so this was reachable
    // by picking it back as well as by never opening it.
    const depositCoin = (depositNode.data.coin as string || '').trim();
    if (!depositCoin) { showAppToast('Pick the coin to deposit.', 'error'); return; }
    const assetIn   = depositCoin.toUpperCase();
    const amountStr = (depositNode.data.amount as string || '0');
    const amount    = parseFloat(amountStr);
    // assetOut still falls back to assetIn: a strategy with no swap/withdraw leg genuinely ends in
    // the asset it started in. Only an EXPLICITLY half-filled swap is ambiguous, so that is what
    // this rejects — an empty To on a node that exists at all.
    if (swapNode && !((swapNode.data.toCoin as string) || '').trim()) {
      showAppToast('Pick the coin to swap into.', 'error'); return;
    }
    const assetOut  = (swapNode?.data.toCoin as string || withdrawNode?.data.coin as string || assetIn).toUpperCase();

    // Parse strategy mode and custom condition tree
    const useTree = strategyKind === 'Limit Order' || strategyNode.data.useTree === 'true';
    let conditionTree = null;

    if (useTree) {
      const rawTree = resolveLimitOrderConditionTree(
        strategyNode.data.conditionTree as string,
        strategyNode.data.priceGoal as string,
        strategyNode.data.side as string
      );
      const treeValidation = validatePriceConditionTreeRaw(rawTree);
      if (!treeValidation.valid) {
        showAppToast(treeValidation.error ?? 'Please build your Limit Order price conditions.', 'error');
        return;
      }
      try {
        conditionTree = JSON.parse(rawTree!);
      } catch {
        showAppToast('Invalid price condition tree.', 'error'); return;
      }
      // Sanity: a price bound wildly off the live market almost always means a malformed
      // strategy (e.g. a stale 1.05 template placeholder) that would fire on the first tick.
      const badBound = implausibleEthBound(conditionTree, ethUsd);
      if (badBound !== null) {
        showAppToast(`Trigger price $${badBound} is unrealistic for ETH (~$${Math.round(ethUsd ?? 0)}). Enter a real price.`, 'error');
        return;
      }
    } else {
      const validation = validateStrategyFields(strategyKind, strategyFields);
      if (!validation.valid) { showAppToast(validation.error ?? 'Strategy parameters are incomplete.', 'error'); return; }
    }

    const recipient = (withdrawNode?.data.wallet as string || '').trim();
    const toChain = chainLabelToId(withdrawNode?.data.chain as string);
    const payloadBounds = buildStrategyPayload(strategyKind, strategyFields);

    if (!amount || amount <= 0) { showAppToast('Deposit node needs a valid amount.', 'error'); return; }
    if (!recipient) { showAppToast('Withdraw node needs a recipient wallet address.', 'error'); return; }

    // Validate recipient address against destination chain format
    const validationError = validateRecipientAddress(recipient, toChain);
    if (validationError) {
      showAppToast(`Recipient address validation failed: ${validationError}`, 'error');
      return;
    }

    // Auto-run Bridge block (Base↔Arb ETH/USDC) before strategy arming on the destination vault.
    if (bridgeNode) {
      const signer = getSigner();
      const wallet = resolveWalletAddress();
      if (!signer || !wallet) {
        showAppToast('Connect your wallet to run the vault bridge.', 'error');
        return;
      }
      if (!peekActiveNoteCursor()) {
        showAppToast(
          'Deposit into the source vault first (or finish a prior deposit) so the Bridge block has an active note.',
          'error',
        );
        return;
      }
      try {
        const bridgeResult = await executeVaultBridgeLeg({
          fromChain: (bridgeNode.data.chain as string) || (depositNode.data.chain as string),
          toChain: bridgeNode.data.toChain as string,
          symbol: ((bridgeNode.data.coin as string) || assetIn || "USDC").toUpperCase(),
          amountHuman: (bridgeNode.data.amount as string) || amountStr,
          signer,
          recipient: wallet,
          onStatus: (m) => showAppToast(m, 'info', 8000),
        });
        setSelectedChainId(bridgeResult.toChainId);
        showAppToast(
          `Bridged to ${bridgeResult.toChainId === 8453 ? "Base" : "Arbitrum"} — arming strategy on destination…`,
          'success',
        );
      } catch (e) {
        showAppToast(e instanceof Error ? e.message : 'Vault bridge failed.', 'error');
        return;
      }
    }

    // Token config for ZK proof generation — sourced from the active network registry.
    const CHAIN_ID = getSelectedChainId();
    const chainTokens = getTokens(CHAIN_ID);
    const TOKEN_CONFIG: Record<string, TokenInfo> = {
      ETH:  { symbol: 'ETH',  decimals: 18, address: chainTokens.ETH.address },
      USDC: { symbol: 'USDC', decimals: 6,  address: chainTokens.USDC.address },
      // Legacy inactive assets; not part of the core Base mainnet loop.
      WBTC: { symbol: 'WBTC', decimals: 8,  address: '0x92f3B59a79bFf5dc60c0d59eA13a44D082B2bdFC' },
      USDT: { symbol: 'USDT', decimals: 6,  address: '0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0' },
    };
    const token = TOKEN_CONFIG[assetIn];
    if (!token) { showAppToast(`Unsupported asset: ${assetIn}`, 'error'); return; }

    // ── Multi-leg (TWAP / Grid): split the deposit into N slices, build N independent swap-proof
    // legs (each a distinct nullifier), encrypt a per-leg trigger (fire-time for TWAP, price band
    // for grid), and submit legs[]. The scheduler fires each leg independently. ──
    // DCA is N equal time-scheduled buys = TWAP mechanics, so it rides the same multi-leg path.
    const isTimeMultiLeg = strategyKind === 'TWAP' || strategyKind === 'DCA';
    const isMultiLeg = isTimeMultiLeg || strategyKind === 'Range';
    if (isMultiLeg) {
      try {
        const outToken = TOKEN_CONFIG[assetOut];
        if (!outToken) { showAppToast(`Unsupported output asset: ${assetOut}`, 'error'); return; }
        const sliceCount = isTimeMultiLeg
          ? (payloadBounds.slices ?? 0)
          : (payloadBounds.grid_levels ?? 0);
        const unitLabel = strategyKind === 'Range' ? 'grid levels' : strategyKind === 'DCA' ? 'buys' : 'slices';
        if (!sliceCount || sliceCount < 2) {
          showAppToast(`Need ≥2 ${unitLabel}.`, 'error');
          return;
        }

        showAppToast(`Splitting deposit into ${sliceCount} ${unitLabel} + building proofs…`, 'info', 10000);
        // The FHE key's entropy IS the connected signer's private key, so it must be requested
        // for that address. `recipient` is the user-TYPED withdraw address from the withdraw node
        // — passing it stored wallet A's key material under wallet B's id, which persistence would
        // now make permanent. getOrCreateClientKey throws on the mismatch; ask for the right one.
        const keyOwner = resolveWalletAddress();
        if (!keyOwner) { showAppToast('Connect your wallet to arm a strategy.', 'error'); return; }
        const clientKey = await getOrCreateClientKey(keyOwner);
        const submitSplit = (s: Parameters<typeof submitSplitOnChain>[2]) => submitSplitOnChain(CHAIN_ID, token, s);

        // Part A: upfront arming fee, carved from the deposit as a protocol fee slice (shielded).
        const windowHours = isTimeMultiLeg
          ? (sliceCount * (payloadBounds.interval_sec ?? 60)) / 3600
          : 24; // grids are open-ended → default 24h window
        const billingWindowHours = Math.max(windowHours * 3, 24);
        console.log(`[Fee] arming + ${billingWindowHours}h window: $${armingChargeUsd(billingWindowHours).toFixed(2)} USDC`);

        // Deposit the user-requested amount as ONE fresh note and split THAT note so every slice is
        // amount/N — NOT a divide of whatever the largest pre-existing note happens to be. Same helper
        // the Discover RUN path uses, so this sibling caller can't silently ignore the typed amount.
        //
        // v2 only: depositForSplit deposits into the v1 Entrypoint and carries requireV2StrategyPath,
        // so calling it on a v3 chain throws before the branch below is even reached. buildV3Multi does
        // the equivalent deposit-then-split against the kernel itself.
        const useV3 = v3StrategiesLive(CHAIN_ID);
        const splitNoteKey = useV3
          ? ""
          : await depositForSplit(CHAIN_ID, token, amountStr, sliceCount, (m) => showAppToast(m, 'info', 4000));

        // Each leg withdraws its slice → swaps → re-deposits the output into the asset_out vault
        // as a private note (output_mode='vault'), matching the single-strategy shielded flow.
        //
        // On a chain running the v3 kernel this routes through buildV3Multi instead: v3 cannot build
        // the leg proof here, because the circuit binds the ASP roots and a proof made at arming is
        // stale by the time the trigger fires. It seals the note secrets to the enclave and the
        // enclave proves at fire time. Same result shape, so everything below is unchanged.
        const multi = useV3
          ? await buildV3Multi({
              chainId: CHAIN_ID,
              signer: getSigner()!,
              screenToken: "", // same-origin/proxied ASP reads, matching UserDash's v3 calls
              inToken: { address: token.address, symbol: token.symbol, decimals: token.decimals },
              outToken: { address: outToken.address, symbol: outToken.symbol, decimals: outToken.decimals },
              amountStr,
              sliceCount,
              windowHours: billingWindowHours,
              swap: await v3SwapParams(CHAIN_ID, token, outToken, clampSlippageBps(payloadBounds.max_slippage_bps ?? undefined)),
              encryptLeg: isTimeMultiLeg
                ? twapEncryptLeg(payloadBounds.interval_sec ?? 60, clientKey)
                : gridEncryptLeg(payloadBounds.lower_bound ?? 0, payloadBounds.upper_bound ?? 0, sliceCount, token.symbol, clientKey),
              submit: createExecutorSubmitV3(getSigner()!),
              log: (m) => showAppToast(m, 'info', 4000),
            })
          : isTimeMultiLeg
          ? await buildTwapLegs({
              chainId: CHAIN_ID, inToken: token, outToken, sliceCount,
              intervalSec: payloadBounds.interval_sec ?? 60,
              clientKeyHex: clientKey, submitSplit, splitNoteKey,
              maxSlippageBps: payloadBounds.max_slippage_bps ?? undefined,
              windowHours: billingWindowHours,
            })
          : await buildGridLegs({
              chainId: CHAIN_ID, inToken: token, outToken,
              low: payloadBounds.lower_bound ?? 0, high: payloadBounds.upper_bound ?? 0,
              levels: sliceCount, clientKeyHex: clientKey, submitSplit, splitNoteKey,
              maxSlippageBps: payloadBounds.max_slippage_bps ?? undefined,
              windowHours: billingWindowHours,
            });

        const mlStrategyData = {
          user_id:           recipient,
          strategy_type:     strategyKind === 'TWAP' ? 'TWAP' : strategyKind === 'DCA' ? 'DCA' : 'RANGE_GRID',
          side:              payloadBounds.side,
          asset_in:          assetIn,
          asset_out:         assetOut,
          amount:            amount,
          recipient_address: recipient,
          legs:              multi.legs,
          interval_sec:      payloadBounds.interval_sec,
          grid_levels:       payloadBounds.grid_levels,
          max_slippage_bps:  payloadBounds.max_slippage_bps,
          schedule_anchor:   multi.scheduleAnchor,
          // Only the v3 builder arms in the enclave; the v2 shape has no such id.
          ...('armStrategyId' in multi ? { arm_strategy_id: multi.armStrategyId } : {}),
          // createStrategy hard-requires note_label. strategySubmit lifts it out of a leg's
          // zk_proof on the v2 path, and a v3 leg has none — so it must be passed explicitly.
          ...('noteLabel' in multi ? { note_label: multi.noteLabel } : {}),
          is_private:        true,
          output_mode:       'vault' as const,
          arming_fee_wei:    multi.armingFeeWei,
          arming_tx_hash:    multi.armingTxHash,
          // Expire + return funds after a generous window (schedule duration ×3, min 24h).
          execution_window_sec: Math.round(billingWindowHours * 3600),
          to_chain:          toChain,
          from_chain:        String(getSelectedChainId()),
        };

        const mlResult = await submitEncryptedStrategy(mlStrategyData, {
          onKeygen:    () => showAppToast('Generating FHE keys (one-time)…', 'info', 5000),
          onUploadKey: () => console.log('[TWAP/Grid] Uploading FHE server key…'),
          onUploadClientKey: () => console.log('[TWAP/Grid] Securing key in the attested enclave…'),
        });
        if (mlResult.success) {
          showSubmitToast(`${strategyKind} registered (${multi.legs.length} legs)! Track it under Dashboard or the Runs tab.`);
          window.dispatchEvent(new CustomEvent('siphon:strategySubmitted', { detail: { strategyId: String(mlResult.data?.strategy_id ?? ''), userId: recipient } }));
        } else {
          showAppToast(mlResult.error || 'Multi-leg submit failed', 'error', 8000);
        }
      } catch (e) {
        console.error('[TWAP/Grid] build failed:', e);
        showAppToast(`Multi-leg build failed: ${e instanceof Error ? e.message : String(e)}`, 'error', 9000);
      }
      return;
    }

    // Stop Loss / Take Profit can act on a fraction of the deposit (Position %). Apply it to the
    // withdrawn + swapped amount; the rest stays as a shielded change note.
    let effectiveAmountStr = amountStr;
    let effectiveAmount = amount;
    if (strategyKind === 'Stop Loss' || strategyKind === 'Take Profit') {
      const pct = resolvePositionPct(strategyFields);
      if (pct < 100) {
        effectiveAmount = amount * pct / 100;
        effectiveAmountStr = String(effectiveAmount);
      }
    }

    // Part A is a single fixed USDC transfer to the executor. It does not touch the vault tree,
    // so the withdrawal proof below remains independent of fee collection.
    showAppToast(`Collecting arming fee ($${armingChargeUsd(0).toFixed(2)} USDC)…`, 'info', 5000);
    const ssArming = await collectArmingFee(CHAIN_ID);
    console.log(`[Fee] single-shot arming fee: $${armingChargeUsd(0).toFixed(2)} USDC`, ssArming.armingTxHash);

    showAppToast(`Generating ZK proof for ${effectiveAmountStr} ${assetIn}...`, 'info', 5000);
    console.log('[Strategy] Generating ZK proof...');

    const outToken = TOKEN_CONFIG[assetOut];
    const isSameChainSwap = assetIn !== assetOut && String(toChain) === String(getSelectedChainId());

    let zkProof: Record<string, unknown>;
    let spentDepositKeys: string[] = [];
    let serverCommitmentIds: Record<string, string | null | undefined> = {};
    let changeValue = 0n;
    let newDepositKey: string | undefined;
    let newDeposit: {
      nullifier: string;
      secret: string;
      commitment?: string;
      precommitment: string;
      nullifierHash?: string;
      label?: string;
      amount: string;
    } | undefined;
    let changePoolId: string | null | undefined;
    let outputMode: 'vault' | 'address' = 'address';
    let outputPrecommitment: string | undefined;
    // Set only on the v3 path, where the leg is sealed to the enclave instead of proved here.
    let v3Single: { armStrategyId: string; noteLabel: string; scheduleAnchor: number } | undefined;

    if (isSameChainSwap && outToken && v3StrategiesLive(CHAIN_ID)) {
      // v3 cannot build the spend proof at arming time: the circuit binds admittedRoot/revokedRoot
      // as public inputs and those move on every ASP publish, so a proof made now is stale before
      // the trigger fires. Seal the note secrets to the attested enclave and let it prove at fire
      // time — the same routing the multi-leg branch above already does via buildV3Multi.
      //
      // Without this branch a v3 chain fell through to armSameChainVaultSwap, which proves against
      // the v1 Entrypoint's tree. The v3 kernel has never seen that root, so the spend could only
      // fail with UnknownStateRoot — after the arming fee was charged and gas paid.
      const { buildV3Single } = await import('../../../lib/v3/strategyOrchestrateV3');
      showAppToast(`Finding the best ${assetIn}/${assetOut} pool…`, 'info', 4000);
      const v3Swap = await v3SwapParams(CHAIN_ID, token, outToken, clampSlippageBps(payloadBounds.max_slippage_bps ?? undefined));

      const single = await buildV3Single({
        chainId: CHAIN_ID,
        signer: getSigner()!,
        screenToken: "", // same-origin/proxied ASP reads, matching the multi-leg branch
        inToken: { address: token.address, symbol: token.symbol, decimals: token.decimals },
        outToken: { address: outToken.address, symbol: outToken.symbol, decimals: outToken.decimals },
        amountStr: effectiveAmountStr,
        // 0, matching the fee this path actually collected (armingChargeUsd(0), and no
        // execution_window_sec on the payload). Passing a different number here would have the
        // executor read a fee tier the user was never charged for.
        windowHours: 0,
        swap: v3Swap,
        submit: createExecutorSubmitV3(getSigner()!),
        log: (m) => showAppToast(m, 'info', 4000),
      });

      // No zk_proof: its ABSENCE is what routes the leg through the executor's attested path
      // (executor_runner._execute_attested_leg). Every other leg shape requires a proof and fails
      // immediately without one, so it is an unambiguous discriminator.
      zkProof = {};
      outputMode = 'vault';
      outputPrecommitment = single.outputPrecommitment;
      v3Single = single;
      console.log('[Strategy] v3 leg sealed to the enclave:', single.armStrategyId);
    } else if (isSameChainSwap && outToken) {
      const { armSameChainVaultSwap } = await import('../../../lib/atomicVaultSwap');
      const armed = await armSameChainVaultSwap({
        chainId: CHAIN_ID,
        inToken: token,
        outToken,
        amountHuman: effectiveAmountStr,
        ethUsdPrice: Number(ethUsd ?? 0) || 0,
        maxSlippageBps: payloadBounds.max_slippage_bps ?? 100,
      });
      if ('error' in armed) {
        showAppToast(`ZK proof failed: ${armed.error}`, 'error');
        return;
      }
      const tx = armed.zkpData;
      zkProof = {
        stateRoot:        tx.stateRoot,
        aspRoot:          tx.aspRoot,
        nullifierHashes:  tx.nullifierHashes,
        changeCommitment: tx.changeCommitment,
        changeLabel:      tx.changeLabel ?? tx.newLabel,
        newLabel:         tx.newLabel,
        newCommitment:    tx.newCommitment,
        amount:           tx.amountIn ?? tx.amount,
        pA: tx.pA,
        pB: tx.pB,
        pC: tx.pC,
        venue: 'swap_and_deposit',
        amountIn: tx.amountIn,
        recipient: tx.recipient,
        pool: tx.pool,
        dstToken: tx.dstToken,
        fee: tx.fee,
        minAmountOut: tx.minAmountOut,
        nullifier: tx.nullifier,
      };
      outputMode = 'vault';
      outputPrecommitment = armed.outputPrecommitment;
      spentDepositKeys = [armed.swapProof.spentNoteKey];
      const chg = armed.swapProof.change;
      const chgWei = BigInt(chg.amountWei || '0');
      if (chgWei > 0n) {
        changeValue = chgWei;
        const { noteKey } = await import('../../../lib/localNoteStore');
        newDeposit = {
          nullifier: chg.nullifier,
          secret: chg.secret,
          commitment: chg.commitment,
          precommitment: chg.precommitment,
          label: chg.label,
          amount: ethers.formatUnits(chgWei, token.decimals),
        };
        newDepositKey = noteKey(CHAIN_ID, token.symbol, chg.commitment);
      }
      console.log('[Strategy] Atomic vault-swap proof generated:', { stateRoot: tx.stateRoot, pool: tx.pool });
    } else {
      const zkResult = await generateZKData(CHAIN_ID, token, effectiveAmountStr, getZkWithdrawRecipient(CHAIN_ID));
      if ('error' in zkResult) {
        showAppToast(`ZK proof failed: ${zkResult.error}`, 'error');
        return;
      }
      const txData = zkResult.withdrawalTxData;
      zkProof = {
        stateRoot:        txData.stateRoot,
        aspRoot:          txData.aspRoot,
        nullifierHashes:  txData.nullifierHashes,
        changeCommitment: txData.changeCommitment,
        changeLabel:      txData.changeLabel,
        amount:           txData.amount,
        // Entrypoint.withdraw._changeValue. Private circuit input, absent from publicSignals —
        // the executor cannot derive it, so dropping it here strands the strategy at fire time.
        changeValue:      txData.changeValue,
        pA: txData.pA,
        pB: txData.pB,
        pC: txData.pC,
      };
      spentDepositKeys = zkResult.spentDepositKeys ?? [];
      serverCommitmentIds = zkResult.serverCommitmentIds ?? {};
      changeValue = zkResult.changeValue;
      newDepositKey = zkResult.newDepositKey;
      newDeposit = zkResult.newDeposit;
      changePoolId = zkResult.changePoolId;
      console.log('[Strategy] ZK proof generated:', { stateRoot: txData.stateRoot, nullifierHashes: txData.nullifierHashes });
    }

    const strategyData = {
      user_id:           recipient,
      strategy_type:     useTree ? 'CUSTOM_STRATEGY' : payloadBounds.strategy_type,
      side:              payloadBounds.side,
      asset_in:          assetIn,
      asset_out:         assetOut,
      amount:            effectiveAmount,
      upper_bound:       useTree ? 0 : payloadBounds.upper_bound,
      lower_bound:       useTree ? 0 : payloadBounds.lower_bound,
      grid_levels:       payloadBounds.grid_levels,
      slices:            payloadBounds.slices,
      interval_sec:      payloadBounds.interval_sec,
      max_slippage_bps:  payloadBounds.max_slippage_bps,
      recipient_address: recipient,
      zk_proof:          zkProof,
      // v3 only. The enclave keys armed legs by (armStrategyId, legIndex), and createStrategy
      // hard-requires note_label — which strategySubmit normally lifts out of a leg's zk_proof,
      // and a v3 leg has none. scheduleAnchor MUST be the value buildV3Single armed with, not a
      // fresh Date.now(): the two differ by however long the arm took, and the enclave would then
      // be asked for a leg key that does not exist.
      ...(v3Single ? {
        arm_strategy_id: v3Single.armStrategyId,
        note_label:      v3Single.noteLabel,
        schedule_anchor: v3Single.scheduleAnchor,
      } : {}),
      is_private:        true,
      commitment_ids:    spentDepositKeys.map(k => serverCommitmentIds[k] ?? null),
      condition_tree:    useTree ? conditionTree : null,
      to_chain:          toChain,
      from_chain:        String(getSelectedChainId()),
      output_mode:       outputMode,
      output_precommitment: outputPrecommitment,
      // Upfront USDC transfer (arming + window); backend verifies sender, recipient, token, amount, replay.
      arming_fee_wei:    ssArming.armingCollectedWei.toString(),
      arming_tx_hash:    ssArming.armingTxHash,
    };

    console.log('[Strategy] Encrypting client-side and submitting to trade-executor:', strategyData);

    const result = await submitEncryptedStrategy(strategyData, {
      onKeygen:    () => showAppToast('Generating your FHE encryption keys (one-time, ~5s)...', 'info', 5000),
      onUploadKey: () => console.log('[Strategy] Uploading FHE server key (one-time)...'),
      onUploadClientKey: () => console.log('[Strategy] Securing key in the attested enclave…'),
      onEncrypt:   () => console.log('[Strategy] Encrypting price conditions locally...'),
    });
    if (result.success) {
      // Persist the change note DURABLY (encrypted localStorage via writeNote + server backup).
      // A raw setItem of the plaintext note has no nullifier_enc/secret_enc, so readNote rejects
      // it and the change value becomes permanently unspendable. Mirrors handler.ts. FUND-SAFETY.
      if (changeValue > 0n && newDepositKey && newDeposit) {
        const _chSigner = getSigner();
        if (_chSigner) {
          try {
            const { writeNote } = await import('../../../lib/localNoteStore');
            await writeNote(newDepositKey, {
              nullifier:     newDeposit.nullifier,
              secret:        newDeposit.secret,
              commitment:    newDeposit.commitment!,
              precommitment: newDeposit.precommitment,
              nullifierHash: newDeposit.nullifierHash ?? '',
              amount:        newDeposit.amount,
              spent:         false,
            }, _chSigner);
          } catch (e) { console.warn('[Strategy] change note write failed:', e); }
          try {
            const { postCommitment } = await import('../../../lib/commitmentStore');
            await postCommitment(_chSigner, {
              nullifier:     newDeposit.nullifier,
              secret:        newDeposit.secret,
              commitment:    newDeposit.commitment!,
              amount:        newDeposit.amount,
              chainId:       CHAIN_ID,
              nullifierHash: newDeposit.nullifierHash ?? '',
              precommitment: newDeposit.precommitment,
            }, token.symbol, 'change');
          } catch (e) { console.warn('[Strategy] change note server save failed:', e); }
          if (changePoolId) {
            try {
              const { resolvePrecommitment } = await import('../../../lib/precommitmentStore');
              await resolvePrecommitment(_chSigner, changePoolId);
            } catch (e) { console.warn('[Strategy] pool resolve failed:', e); }
          }
        } else {
          console.warn('[Strategy] no signer — change note NOT persisted durably (would strand change)');
        }
      }

      const strategyId = String(result.data?.strategy_id ?? result.data?.payload_id ?? '');

      // Reserve the spent input notes (mark 'pending') so a normal withdrawal can't drain them in
      // the window between arming and execution. Reconciled to 'true'/'false' on EXECUTED/FAILED.
      const _resSigner = getSigner();
      if (_resSigner && strategyId) {
        void reserveStrategyNotes(
          _resSigner,
          strategyId,
          spentDepositKeys.map((k) => serverCommitmentIds[k]),
        );
      }

      // Defer localStorage cleanup until siphon:strategyExecuted confirms on-chain withdrawal.
      // If we delete now and the executor fails, the user loses note secrets permanently.
      // Store the mapping strategyId → spent keys so the event handler can clean up later.
      if (strategyId && spentDepositKeys.length > 0) {
        try {
          localStorage.setItem(
            `siphon-pending-cleanup-${strategyId}`,
            JSON.stringify(spentDepositKeys),
          );
        } catch { /* non-critical */ }
      } else {
        // No strategyId to key off — fall back to immediate cleanup (same as before).
        for (const k of spentDepositKeys) { try { localStorage.removeItem(k); } catch {} }
      }

      // Mark the input notes spent:true LOCALLY now so a concurrent withdraw can't re-select and
      // double-spend them in the arm→execute window. markNoteSpent preserves the encrypted secret;
      // reconcileReservedNotes reverts them to spent:false if the strategy FAILS, and they're
      // deleted for good on siphon:strategyExecuted.
      if (strategyId && spentDepositKeys.length > 0) {
        try {
          const { markNoteSpent } = await import('../../../lib/localNoteStore');
          for (const k of spentDepositKeys) markNoteSpent(k, true);
        } catch { /* best-effort */ }
      }

      // Strategy is registered with the trade-executor and runs server-side.
      if (strategyId) {
        window.dispatchEvent(
          new CustomEvent('siphon:strategySubmitted', { detail: { strategyId, userId: recipient } }),
        );
      }

      if (useTree) {
        showSubmitToast('Strategy registered! Track it under Dashboard or the Runs tab.');
      } else {
        showSubmitToast('Strategy registered! Track it under Dashboard or the Runs tab.');
      }
    } else {
      showAppToast(`Strategy failed: ${result.error}`, 'error');
    }
  }, [nodes]);
  
  const onRestart = useCallback(() => {
    setNodes([]);
    setEdges([]);
    setCurrentFileName('untitled.io');
    setBuilderSession(null);
    setBuilderMessages([]);
    setBuilderPrompt("");
    setBuildViewActive(false);
  }, [setNodes, setEdges, setCurrentFileName]);

  // Clicking the "Siphon Protocol" logo returns to the builder landing (home) by clearing any
  // loaded strategy graph. Nav dispatches this since the logo lives outside this component.
  useEffect(() => {
    const goHome = () => onRestart();
    window.addEventListener('siphon:go-home', goHome);
    return () => window.removeEventListener('siphon:go-home', goHome);
  }, [onRestart]);
  
  const saveScene = useCallback((sceneName: string) => {
    const scene = {
      name: sceneName,
      nodes: nodes.map(node => ({
        ...node,
        data: node.data
      })),
      edges: edges.map(edge => ({
        ...edge,
        data: edge.data
      }))
    };
    
    const updatedScenes = [...savedScenes.filter(s => s.name !== sceneName), scene];
    setSavedScenes(updatedScenes);
    localStorage.setItem('siphon-blueprint-scenes', JSON.stringify(updatedScenes));
  }, [nodes, edges, savedScenes, setSavedScenes]);
  
  const loadScene = useCallback((sceneName: string) => {
    const scene = savedScenes.find(s => s.name === sceneName);
    if (scene) {
      // Normalize all nodes to ensure they have required properties
      const normalizedNodes = sortAndSyncRepeat(scene.nodes.map(normalizeNode));
      setNodes(normalizedNodes);
      setEdges(scene.edges);
      setCurrentFileName(`${sceneName}.io`);
    }
  }, [savedScenes, setNodes, setEdges, setCurrentFileName, normalizeNode]);
  
  const deleteScene = useCallback((sceneName: string) => {
    if (confirm(`Delete scene "${sceneName}"?`)) {
      const updatedScenes = savedScenes.filter(s => s.name !== sceneName);
      setSavedScenes(updatedScenes);
      localStorage.setItem('siphon-blueprint-scenes', JSON.stringify(updatedScenes));
    }
  }, [savedScenes, setSavedScenes]);

  const onBuilderPromptSubmit = useCallback(async (prompt: string) => {
    const userMsg: BuildChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: prompt,
    };
    const chatHistory = [
      ...builderMessages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: prompt },
    ];
    setBuilderMessages((prev) => [...prev, userMsg]);
    setIsBuilderAgentLoading(true);
    try {
      const result = await processBuilderTurn(
        prompt,
        builderSession,
        nodes,
        edges,
        chatHistory,
        {
          ethUsd,
          chainId: getSelectedChainId(),
          homeChainId: readStoredHomeChainId(),
        }
      );
      setNodes(result.nodes);
      setEdges(result.edges);
      setBuilderSession(result.session);
      if (result.botMessage) {
        const botMessage = result.botMessage;
        setBuilderMessages((prev) => [
          ...prev,
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: botMessage,
          },
        ]);
      }
      setBuilderPrompt("");
      setNodeContextMenu(null);
    } finally {
      setIsBuilderAgentLoading(false);
    }
  }, [builderSession, builderMessages, nodes, edges, ethUsd, setNodes, setEdges]);

  const buildStrategyName = useMemo(
    () => currentFileName.replace(/\.io$/i, '') || 'untitled',
    [currentFileName]
  );

  const getStrategyDescription = useCallback((strategyNodes: Node[]) => {
    const nodeTypes = strategyNodes.map((n) => n.data.type);
    const hasDeposit = nodeTypes.includes('deposit');
    const hasSwap = nodeTypes.includes('swap');
    const hasLend = nodeTypes.includes('lend');
    const hasWithdraw = nodeTypes.includes('withdraw');
    const hasStrategy = nodeTypes.includes('strategy');

    const parts: string[] = [];
    if (hasDeposit) parts.push('Deposit');
    if (hasLend) parts.push('Earn');
    if (hasSwap) parts.push('Swap');
    if (hasStrategy) parts.push('Strategy');
    if (hasWithdraw) parts.push('Withdraw');

    if (parts.length === 0) return 'Empty strategy';
    if (parts.length === 1) return `${parts[0]} operation`;
    if (parts.length === 2) return `${parts[0]} -> ${parts[1]}`;
    return `${parts[0]} -> ${parts.slice(1, -1).join(' -> ')} -> ${parts[parts.length - 1]}`;
  }, []);

  const buildRunStrategyMeta = useMemo((): StrategyMetadata => ({
    name: buildStrategyName,
    author: 'You',
    nodes: getModalStepNodes(nodes, edges).length,
    usage: 0,
    profit: '+0.00%',
    description: getStrategyDescription(nodes),
    category: 'custom',
    chains: ['base'],
    networks: ['Base'],
    activeNetworks: ['Base'],
    isActive: true,
  }), [buildStrategyName, nodes, edges, getStrategyDescription]);

  const openRunModal = useCallback(() => {
    const synced = sortAndSyncRepeat(nodes.map(normalizeNode));
    setRunModalNodes(formatGraphForPreview(synced));
    setRunModalEdges(edges);
    setRunFlowKey((k) => k + 1);
    setIsRunMode(true);
    setRunModeValues(buildRunModeValuesFromNodes(synced));
    setShowRunModal(true);
  }, [nodes, edges, normalizeNode]);
  
  return (
    <div
      className={`blueprint-view blueprint-view--fullscreen ${isLoaded ? 'loaded' : ''} ${widgetsVisible ? 'blueprint-view--dash-front' : ''} ${chatFocus || buildViewActive || (!widgetsVisible && hasCanvasContent) ? 'blueprint-view--chat-active' : ''}`}
      onMouseMove={(e) => {
        // Direct DOM write, not React state — this fires on every pixel of mouse movement, and
        // the dot-grid highlight only needs to read these via CSS var(), not re-render anything.
        e.currentTarget.style.setProperty('--dot-mx', `${e.clientX}px`);
        e.currentTarget.style.setProperty('--dot-my', `${e.clientY}px`);
      }}
    >
      <ReactFlowProvider>
        <div className="blueprint-workspace">
          <BuildNav
            nodes={nodes}
            currentFileName={currentFileName}
            savedScenes={savedScenes}
            onAddNode={onAddNode}
            onSaveScene={saveScene}
            onLoadScene={loadScene}
            onDeleteScene={deleteScene}
            onRestart={onRestart}
            onSimulate={() => void runSimulation()}
            isSimulating={isSimulating}
            onOpenRun={openRunModal}
            setCurrentFileName={setCurrentFileName}
            expandedToolbar={canvasExpanded}
          />

          {simToast && (
            <BuildSimToast
              message={simToast.message}
              type={simToast.type}
              exiting={simExiting}
              onDismiss={dismissToast}
            />
          )}

          {!simToast && submitToast && (
            <BuildSimToast
              message={submitToast}
              type="success"
              exiting={submitToastExiting}
              onDismiss={dismissSubmitToast}
            />
          )}

          <div className="blueprint-stage">
            <div className="blueprint-canvas" onContextMenu={onCanvasContextMenu}>
            <BlueprintFlow
              setNodes={setNodes}
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeContextMenu={onNodeContextMenu}
              onPaneContextMenu={onPaneContextMenu}
              onPaneClick={() => setNodeContextMenu(null)}
              onMoveStart={() => setNodeContextMenu(null)}
              onNodesDelete={(nodesToDelete) => {
                nodesToDelete.forEach((node) => onDeleteNode(node.id));
              }}
              updateNodeData={updateNodeData}
              tokens={tokens}
              isTokenActive={isTokenActive}
              simHighlight={simHighlight}
              simShakingId={simShakingId}
              simExiting={simExiting}
            />
            </div>

            <RunningStrategiesProvider runningStrategies={runningStrategies ?? new Map()}>
            <DashboardCustomizeProvider>
            <div
              ref={pageLayoutRef}
              className={`build-page-layout ${canvasExpanded ? "build-page-layout--focus" : ""}`}
            >
              <div className="build-page-content">
                <BuildHeroBand
                  value={builderPrompt}
                  onChange={setBuilderPrompt}
                  onSubmit={onBuilderPromptSubmit}
                  isLoading={isBuilderAgentLoading}
                  messages={builderMessages}
                  onChatActiveChange={handleChatActiveChange}
                  widgetsVisible={widgetsVisible}
                  onToggleWidgets={handleToggleWidgets}
                  buildViewActive={buildViewActive || (!widgetsVisible && hasCanvasContent)}
                />

                <div
                  className={`build-widget-band${widgetsVisible ? "" : " build-widget-band--hidden"}`}
                  aria-hidden={!widgetsVisible}
                >
                  <BuildWidgetSection />
                </div>
              </div>
            </div>
            </DashboardCustomizeProvider>
            </RunningStrategiesProvider>

            {widgetsVisible && <BuildPageFooter />}

            {nodeContextMenu && (
              <BuildNodeContextMenu
                x={nodeContextMenu.x}
                y={nodeContextMenu.y}
                nodeLabel={nodes.find((node) => node.id === nodeContextMenu.nodeId)?.data.label as string | undefined}
                onDelete={() => onDeleteNode(nodeContextMenu.nodeId)}
                onDuplicate={() => onDuplicateNode(nodeContextMenu.nodeId)}
                onClose={() => setNodeContextMenu(null)}
              />
            )}
          </div>
        </div>
      </ReactFlowProvider>

      {showRunModal && (
        <DetailsModal
          selectedStrategy={buildRunStrategyMeta}
          isOpen={showRunModal}
          onClose={() => {
            setShowRunModal(false);
            setIsRunMode(false);
            setRunModeValues({});
          }}
          isRunMode={isRunMode}
          setIsRunMode={setIsRunMode}
          modalStrategyNodes={runModalNodes}
          modalStrategyEdges={runModalEdges}
          runModeValues={runModeValues}
          setRunModeValues={setRunModeValues}
          runDuration={runDuration}
          setRunDuration={setRunDuration}
          isFading={isFading}
          setIsFading={setIsFading}
          flowKey={runFlowKey}
          isFlowLoading={false}
          runningStrategies={runningStrategies}
          setRunningStrategies={setRunningStrategies}
          setNodes={setNodes}
          setEdges={setEdges}
          setViewMode={(mode) => setViewMode?.(mode)}
          setCurrentFileName={setCurrentFileName}
          savedScenes={savedScenes}
          setSavedScenes={setSavedScenes}
          setShowSuccessNotification={setShowSuccessNotification}
          fromBuilder
        />
      )}
    </div>
  );
}
