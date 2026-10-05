/**
 * Strategies Data and Utilities
 * 
 * Contains all strategy-related data, metadata, and initialization logic
 */

import { Node, Edge, Position } from '@xyflow/react';
import { layoutStrategyNodes } from '../../../lib/builderLayout';
import { formatGraphForPreview } from '../../../lib/repeatGraph';
import { applySwapToWithdrawLink } from '../../../lib/graphLinks';
import { REPEAT_GROUP_DEFAULT_SIZE, syncRepeatGroups } from '../../../lib/repeatGraph';
import { stripNodeWrapperStyle } from '../../../lib/builderNodeStyle';
import { getNetwork, getSelectedChainId } from '../../../lib/networks';

/**
 * The network label to stamp into a preset's deposit/withdraw nodes.
 *
 * Presets used to hard-code 'Sepolia'. Build.tsx derives `toChain` from the withdraw node
 * (`chainLabelToId(withdrawNode.data.chain)`), so on Base that resolved to 11155111, made
 * `isSameChainSwap` false, and dropped arming onto the pre-v3 path — a v1 Entrypoint proof
 * against a tree the v5 kernel has never seen, charged only after the arming fee. Presets with no
 * withdraw node escaped solely because `chainLabelToId(undefined)` happens to default to "8453".
 *
 * `getNetwork().name` round-trips through CHAIN_LABEL_TO_ID for every supported chain.
 */
function activeChainLabel(): string {
  try {
    return getNetwork(getSelectedChainId()).name;
  } catch {
    return 'Base';
  }
}

export interface StrategyMetadata {
  name: string;
  author: string;
  nodes: number;
  usage: string | number;
  profit: string;
  description: string;
  category: string;
  chains: string[];
  networks: string[];
  activeNetworks?: string[]; // Networks that are currently active for this strategy
  isActive?: boolean;
}

export interface FeaturedStrategy {
  badge: string;
  title: string;
  description: string;
  stats: {
    apy: string;
    users: string;
    risk: string;
  };
  networks: string[];
}

export interface StrategyData {
  name?: string;
  nodes: Node[];
  edges: Edge[];
  author?: string;
  usage?: number;
  profit?: string;
  category?: string;
  chains?: string[];
  networks?: string[];
}

/** Filter bar + card badge order — Base is live; others shown as coming soon. */
export const DISCOVER_FILTER_NETWORKS = [
  'Base',
  'Ethereum',
  'Arbitrum',
  'Optimism',
  'Polygon',
 
] as const;

export const DISCOVER_STRATEGY_NETWORKS = [
  'Base',
  'Ethereum',
  'Arbitrum',
  'Optimism',
  'Polygon',
] as const;

export const DISCOVER_STRATEGY_CHAINS = [
  'base',
  'ethereum',
  'arbitrum',
  'optimism',
  'polygon',
] as const;

export const DISCOVER_ACTIVE_NETWORK = 'Base';

/**
 * Strategy list metadata
 */
export const strategyList: StrategyMetadata[] = [
  { 
    name: 'Limit Order', 
    author: 'Siphon Team', 
    nodes: 4, 
    usage: 25, 
    profit: '+5.2%', 
    description: 'Set your desired price and wait for the market to reach it. Execute trades at your specified price level for better control.', 
    category: 'trading', 
    chains: [...DISCOVER_STRATEGY_CHAINS], 
    networks: [...DISCOVER_STRATEGY_NETWORKS],
    activeNetworks: [DISCOVER_ACTIVE_NETWORK],
    isActive: true 
  },
  {
    name: 'DCA Accumulator',
    author: 'Siphon Team',
    nodes: 3,
    usage: 18,
    profit: '+2.1%',
    description: 'Deposit once, then buy on a fixed cadence — N shielded legs with encrypted fire-times.',
    category: 'trading',
    chains: [...DISCOVER_STRATEGY_CHAINS],
    networks: [...DISCOVER_STRATEGY_NETWORKS],
    activeNetworks: [DISCOVER_ACTIVE_NETWORK],
    isActive: true
  },
  {
    name: 'Grid Trading',
    author: 'Siphon Team',
    nodes: 3,
    usage: 14,
    profit: '+3.4%',
    description: 'Buy-side grid — N shielded rungs stepping down through a price band, each an independent leg.',
    category: 'trading',
    chains: [...DISCOVER_STRATEGY_CHAINS],
    networks: [...DISCOVER_STRATEGY_NETWORKS],
    activeNetworks: [DISCOVER_ACTIVE_NETWORK],
    isActive: true
  },
  {
    name: 'TWAP Executor',
    author: 'Siphon Team',
    nodes: 5,
    usage: 9,
    profit: '+4.1%',
    description: 'Slice a large order into N shielded legs over time — private cadence (encrypted fire-times), one swap per slice.',
    category: 'trading',
    chains: [...DISCOVER_STRATEGY_CHAINS],
    networks: [...DISCOVER_STRATEGY_NETWORKS],
    activeNetworks: [DISCOVER_ACTIVE_NETWORK],
    isActive: true
  },
  {
    name: 'Range Grid Bot',
    author: 'Siphon Team',
    nodes: 6,
    usage: 11,
    profit: '+6.8%',
    description: 'Automated buy/sell legs across a price range — N independent shielded rungs.',
    category: 'trading',
    chains: [...DISCOVER_STRATEGY_CHAINS],
    networks: [...DISCOVER_STRATEGY_NETWORKS],
    activeNetworks: [DISCOVER_ACTIVE_NETWORK],
    isActive: true
  },
  {
    name: 'Stop-Loss Shield',
    author: 'Siphon Team',
    nodes: 3,
    usage: 7,
    profit: '+1.9%',
    description: 'Sell when price drops to your stop level — swaps ETH to stablecoin and re-shields the proceeds.',
    category: 'trading',
    chains: [...DISCOVER_STRATEGY_CHAINS],
    networks: [...DISCOVER_STRATEGY_NETWORKS],
    activeNetworks: [DISCOVER_ACTIVE_NETWORK],
    isActive: true
  },
  {
    name: 'Take-Profit Lock',
    author: 'Siphon Team',
    nodes: 3,
    usage: 6,
    profit: '+2.4%',
    description: 'Sell when price rises to your target — swaps ETH to stablecoin and re-shields the proceeds.',
    category: 'trading',
    chains: [...DISCOVER_STRATEGY_CHAINS],
    networks: [...DISCOVER_STRATEGY_NETWORKS],
    activeNetworks: [DISCOVER_ACTIVE_NETWORK],
    isActive: true
  },
];

/**
 * Featured strategies data
 */
export const featuredStrategies: FeaturedStrategy[] = [
  {
    badge: 'Strategy of the Week',
    title: 'Cross-Chain Arbitrage Pro',
    description: 'Automated arbitrage detection across Solana, Ethereum, and Base networks. Maximize profits by finding price discrepancies in real-time.',
    stats: {
      apy: '+127.3%',
      users: '1,234',
      risk: 'Low'
    },
    networks: ['Solana', 'Ethereum', 'Base']
  },
  {
    badge: 'Strategy of the Month',
    title: 'Yield Farming Optimizer',
    description: 'Automatically rebalance across multiple yield farms to maximize returns. Dynamic allocation based on real-time APY data and risk assessment.',
    stats: {
      apy: '+89.5%',
      users: '3,456',
      risk: 'Medium'
    },
    networks: ['Ethereum', 'Polygon', 'Arbitrum']
  },
  {
    badge: 'Most Used Strategy',
    title: 'DCA Accumulation Bot',
    description: 'Dollar-cost averaging strategy with intelligent timing. Automatically purchases assets at optimal intervals to reduce volatility impact.',
    stats: {
      apy: '+45.2%',
      users: '8,901',
      risk: 'Low'
    },
    networks: ['Solana', 'Bitcoin', 'Ethereum']
  }
];

type BlockType = 'deposit' | 'strategy' | 'swap' | 'withdraw' | 'control' | 'repeatGroup';

interface StrategyNodeTemplate {
  id: string;
  x: number;
  y: number;
  parentId?: string;
  nodeType?: 'custom' | 'repeatGroup';
  data: {
    label: string;
    type: BlockType;
    chain?: string;
    coin?: string;
    amount?: string;
    strategy?: string;
    side?: string;
    priceGoal?: string;
    rangeLow?: string;
    rangeHigh?: string;
    gridLevels?: string;
    sliceCount?: string;
    intervalSeconds?: string;
    maxSlippageBps?: string;
    positionPct?: string;
    controlKind?: string;
    repeatMode?: string;
    repeatCount?: string;
    loopIntervalValue?: string;
    loopIntervalUnit?: string;
    loopIntervalSec?: string;
    scheduleTrigger?: string;
    scheduleValue?: string;
    scheduleUnit?: string;
    scheduleDelaySec?: string;
    amountSource?: string;
    linkedFromNodeId?: string;
    dex?: string;
    toCoin?: string;
    wallet?: string;
  };
}

interface StrategyEdgeTemplate {
  source: string;
  target: string;
}

interface StrategyTemplateSpec {
  nodes: StrategyNodeTemplate[];
  edges: StrategyEdgeTemplate[];
}

const EDGE_STYLE = { stroke: 'rgba(255, 255, 255, 0.3)', strokeWidth: 2 };

// Declarative library: graph specs only, composed into existing Build nodes.
const STRATEGY_LIBRARY_SPECS: Record<string, StrategyTemplateSpec> = {
  'Limit Order': {
    // No withdraw node: the swap is an atomic Vault.swap (output goes straight to the
    // recipient / back into the vault as a note). Funds never leave to the executor wallet.
    nodes: [
      { id: 'deposit', x: 100, y: 200, data: { label: 'Deposit', type: 'deposit', chain: '', coin: 'USDC' } },
      { id: 'strategy', x: 400, y: 200, data: { label: 'Limit Order', type: 'strategy', strategy: 'Limit Order' } },
      { id: 'swap', x: 700, y: 200, data: { label: 'Swap', type: 'swap', dex: 'Uniswap', coin: 'USDC', toCoin: 'ETH' } },
    ],
    edges: [
      { source: 'deposit', target: 'strategy' },
      { source: 'strategy', target: 'swap' },
    ],
  },
  // N scheduled buys. Modelled as a DCA strategy node, NOT a repeatGroup: Build.tsx selects the
  // strategy with `nodes.find(type === 'strategy')`, so the old Loop{swap, withdraw} shape — which
  // had no strategy node at all — could only ever stop at "Add a Strategy node first." DCA is a
  // first-class multi-leg type (strategySpec maps it to encrypted fire-times, exactly like TWAP),
  // so the node the builder already understands is the whole fix. Buys/interval are set on the node.
  'DCA Accumulator': {
    nodes: [
      { id: 'deposit', x: 100, y: 200, data: { label: 'Deposit', type: 'deposit', chain: '', coin: 'USDC' } },
      { id: 'strategy', x: 400, y: 200, data: { label: 'DCA', type: 'strategy', strategy: 'DCA' } },
      { id: 'swap', x: 700, y: 200, data: { label: 'Swap', type: 'swap', dex: 'Uniswap', coin: 'USDC', toCoin: 'ETH' } },
    ],
    edges: [
      { source: 'deposit', target: 'strategy' },
      { source: 'strategy', target: 'swap' },
    ],
  },
  // A buy-side grid: rungs stepping DOWN through the band, accumulating ETH with USDC. Range Grid
  // Bot is the same machinery pointed the other way (ETH → USDC).
  //
  // Was Limit Order → Take Profit chained as entry and exit. `nodes.find(type === 'strategy')`
  // returns the FIRST match, so only the entry ever armed and the exit was silently dropped — the
  // card promised a round trip and delivered half of one. A two-strategy chain needs fire-on-fill
  // re-arming, which does not exist; RANGE_GRID is the real multi-leg primitive and is what this
  // card's own description ("N shielded rungs across a price band") already describes.
  'Grid Trading': {
    nodes: [
      { id: 'deposit', x: 100, y: 200, data: { label: 'Deposit', type: 'deposit', chain: '', coin: 'USDC' } },
      { id: 'strategy', x: 400, y: 200, data: { label: 'Range', type: 'strategy', strategy: 'Range' } },
      { id: 'swap', x: 700, y: 200, data: { label: 'Swap', type: 'swap', dex: 'Uniswap', coin: 'USDC', toCoin: 'ETH' } },
    ],
    edges: [
      { source: 'deposit', target: 'strategy' },
      { source: 'strategy', target: 'swap' },
    ],
  },
  // No withdraw node, matching Limit Order: the fill is an atomic vault swap and the proceeds are
  // re-shielded as a note (output_mode='vault'). The withdraw block these two used to carry never
  // executed on a v3/v5 chain — it only fed `toChain`, which is what pushed arming onto the dead
  // pre-v3 path. Exit to an address is a separate withdraw from the dashboard.
  'Stop-Loss Shield': {
    nodes: [
      { id: 'deposit', x: 100, y: 200, data: { label: 'Deposit', type: 'deposit', chain: '', coin: 'ETH' } },
      { id: 'strategy', x: 400, y: 200, data: { label: 'Stop Loss', type: 'strategy', strategy: 'Stop Loss' } },
      { id: 'swap', x: 700, y: 200, data: { label: 'Swap', type: 'swap', dex: 'Uniswap', coin: 'ETH', toCoin: 'USDC' } },
    ],
    edges: [
      { source: 'deposit', target: 'strategy' },
      { source: 'strategy', target: 'swap' },
    ],
  },
  'Take-Profit Lock': {
    nodes: [
      { id: 'deposit', x: 100, y: 200, data: { label: 'Deposit', type: 'deposit', chain: '', coin: 'ETH' } },
      { id: 'strategy', x: 400, y: 200, data: { label: 'Take Profit', type: 'strategy', strategy: 'Take Profit' } },
      { id: 'swap', x: 700, y: 200, data: { label: 'Swap', type: 'swap', dex: 'Uniswap', coin: 'ETH', toCoin: 'USDC' } },
    ],
    edges: [
      { source: 'deposit', target: 'strategy' },
      { source: 'strategy', target: 'swap' },
    ],
  },
  // Multi-leg: split one deposit into N shielded slices/rungs (atomic Vault.swap per leg, no
  // withdraw node). The strategy node carries the slice/grid config the multi-leg builder reads.
  'TWAP Executor': {
    nodes: [
      { id: 'deposit', x: 100, y: 200, data: { label: 'Deposit', type: 'deposit', chain: '', coin: 'ETH' } },
      { id: 'strategy', x: 400, y: 200, data: { label: 'TWAP', type: 'strategy', strategy: 'TWAP' } },
      { id: 'swap', x: 700, y: 200, data: { label: 'Swap', type: 'swap', dex: 'Uniswap', coin: 'ETH', toCoin: 'USDC' } },
    ],
    edges: [
      { source: 'deposit', target: 'strategy' },
      { source: 'strategy', target: 'swap' },
    ],
  },
  'Range Grid Bot': {
    nodes: [
      { id: 'deposit', x: 100, y: 200, data: { label: 'Deposit', type: 'deposit', chain: '', coin: 'ETH' } },
      { id: 'strategy', x: 400, y: 200, data: { label: 'Range', type: 'strategy', strategy: 'Range' } },
      { id: 'swap', x: 700, y: 200, data: { label: 'Swap', type: 'swap', dex: 'Uniswap', coin: 'ETH', toCoin: 'USDC' } },
    ],
    edges: [
      { source: 'deposit', target: 'strategy' },
      { source: 'strategy', target: 'swap' },
    ],
  },
};

function composeStrategyGraph(name: string): { nodes: Node[]; edges: Edge[] } {
  const spec = STRATEGY_LIBRARY_SPECS[name];
  if (!spec) return { nodes: [], edges: [] };

  const chain = activeChainLabel();

  const nodes: Node[] = spec.nodes.map((node) => {
    const isRepeat = node.nodeType === 'repeatGroup' || node.data.type === 'repeatGroup';
    const isChild = Boolean(node.parentId);

    return stripNodeWrapperStyle({
      id: node.id,
      type: isRepeat ? 'repeatGroup' : 'custom',
      parentId: node.parentId,
      extent: node.parentId ? 'parent' : undefined,
      position: { x: node.x, y: node.y },
      data: {
        ...node.data,
        // Specs declare `chain: ''` and this fills in the connected network — see activeChainLabel.
        ...(node.data.chain !== undefined ? { chain } : {}),
        childCount: isRepeat
          ? spec.nodes.filter((n) => n.parentId === node.id).length
          : undefined,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      zIndex: isChild ? 10 : isRepeat ? 1 : 0,
      ...(isRepeat
        ? {
            style: {
              width: REPEAT_GROUP_DEFAULT_SIZE.width,
              height: REPEAT_GROUP_DEFAULT_SIZE.height,
              padding: 0,
              background: 'transparent',
              border: 'none',
            },
          }
        : {}),
    });
  });

  const edges: Edge[] = spec.edges.map((edge, idx) => ({
    id: `xy-edge__${edge.source}-${edge.target}-${idx}`,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    style: EDGE_STYLE,
  }));

  let laidOut = layoutStrategyNodes(nodes, edges);
  for (const edge of spec.edges) {
    laidOut = applySwapToWithdrawLink(laidOut, {
      source: edge.source,
      target: edge.target,
      sourceHandle: null,
      targetHandle: null,
    });
  }

  return { nodes: laidOut, edges };
}

export function formatStrategyGraphForModal(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: formatGraphForPreview(nodes),
    edges,
  };
}

function getTemplateStrategyData(strategyName: string): StrategyData | null {
  if (strategyName === 'Limit Order') {
    const { nodes, edges } = createLimitOrderStrategy();
    return { nodes, edges };
  }
  const other = createOtherStrategies();
  return other[strategyName] ?? null;
}

/** Load a library strategy graph for Build / modal preview. */
export function loadStrategyGraphByName(strategyName: string): { nodes: Node[]; edges: Edge[] } {
  const template = getTemplateStrategyData(strategyName);
  if (template?.nodes?.length && template?.edges?.length) {
    return formatStrategyGraphForModal(template.nodes as Node[], template.edges as Edge[]);
  }

  const discoverStrategiesKey = 'siphon-discover-strategies';
  const stored = localStorage.getItem(discoverStrategiesKey);
  if (stored) {
    try {
      const strategiesData = JSON.parse(stored) as Record<string, StrategyData>;
      const strategyData = strategiesData[strategyName];
      if (strategyData?.nodes?.length && strategyData?.edges?.length) {
        const formattedNodes = strategyData.nodes.map((node: Node) => ({
          ...node,
          type: node.type || 'custom',
          position: node.position || { x: 0, y: 0 },
        }));
        const formattedEdges = strategyData.edges.map((edge: Edge) => ({
          ...edge,
          type: edge.type || 'smoothstep',
        }));
        return formatStrategyGraphForModal(formattedNodes, formattedEdges);
      }
    } catch (error) {
      console.error('Failed to load strategy data from localStorage:', error);
    }
  }

  return { nodes: [], edges: [] };
}

/**
 * Create Limit Order strategy nodes and edges
 */
export const createLimitOrderStrategy = (): { nodes: Node[]; edges: Edge[] } => {
  return composeStrategyGraph('Limit Order');
};

/**
 * Create other strategy nodes and edges
 */
export const createOtherStrategies = (): Record<string, StrategyData> => {
  return {
    'DCA Accumulator': { name: 'DCA Accumulator', ...composeStrategyGraph('DCA Accumulator') },
    'Grid Trading': { name: 'Grid Trading', ...composeStrategyGraph('Grid Trading') },
    'Stop-Loss Shield': { name: 'Stop-Loss Shield', ...composeStrategyGraph('Stop-Loss Shield') },
    'Take-Profit Lock': { name: 'Take-Profit Lock', ...composeStrategyGraph('Take-Profit Lock') },
    'TWAP Executor': { name: 'TWAP Executor', ...composeStrategyGraph('TWAP Executor') },
    'Range Grid Bot': { name: 'Range Grid Bot', ...composeStrategyGraph('Range Grid Bot') },
  };
};

/**
 * Initialize Limit Order strategy in localStorage
 */
export const initializeLimitOrderStrategy = (): void => {
  const discoverStrategiesKey = 'siphon-discover-strategies';
  const stored = localStorage.getItem(discoverStrategiesKey);
  let discoverStrategies: Record<string, StrategyData> = {};
  
  if (stored) {
    try {
      discoverStrategies = JSON.parse(stored);
    } catch (error) {
      console.error('Failed to parse discover strategies:', error);
    }
  }
  
  // Only initialize if Limit Order doesn't exist
  if (!discoverStrategies['Limit Order']) {
    const { nodes, edges } = createLimitOrderStrategy();
    
    discoverStrategies['Limit Order'] = {
      nodes,
      edges,
      author: 'Siphon Team',
      usage: 25,
      profit: '+5.2%',
      category: 'trading',
      chains: [...DISCOVER_STRATEGY_CHAINS],
      networks: [...DISCOVER_STRATEGY_NETWORKS]
    };
    
    localStorage.setItem(discoverStrategiesKey, JSON.stringify(discoverStrategies));
  }
};

/**
 * Initialize all discover strategies in localStorage
 */
export const initializeDiscoverStrategies = (): void => {
  const discoverStrategiesKey = 'siphon-discover-strategies';
  const stored = localStorage.getItem(discoverStrategiesKey);

  const templates = createOtherStrategies();
  if (!stored) {
    localStorage.setItem(discoverStrategiesKey, JSON.stringify(templates));
    return;
  }

  try {
    const current = JSON.parse(stored) as Record<string, StrategyData>;
    const merged: Record<string, StrategyData> = { ...current };

    // Migrate previous template names to current display names.
    if (!merged['DCA Accumulator'] && merged['DCA Accumulator (Safe Test)']) {
      merged['DCA Accumulator'] = merged['DCA Accumulator (Safe Test)'];
    }
    if (!merged['Grid Trading'] && merged['Grid Trading (Safe Test)']) {
      merged['Grid Trading'] = merged['Grid Trading (Safe Test)'];
    }
    delete merged['DCA Accumulator (Safe Test)'];
    delete merged['Grid Trading (Safe Test)'];

    Object.entries(templates).forEach(([name, strategy]) => {
      merged[name] = {
        ...(merged[name] ?? {}),
        ...strategy,
        name,
        nodes: strategy.nodes,
        edges: strategy.edges,
      };
    });
    localStorage.setItem(discoverStrategiesKey, JSON.stringify(merged));
  } catch {
    localStorage.setItem(discoverStrategiesKey, JSON.stringify(templates));
  }
};


