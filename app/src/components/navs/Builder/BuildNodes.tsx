"use client";

import { Handle, Position } from '@xyflow/react';
import { normalizeStrategyKind, type ScheduleUnit, displayScheduleFromSeconds } from "../../../lib/strategySpec";
import { simHighlightClass } from "./simHighlight";
import type { SimHighlightStatus } from "./useCanvasSimulation";
import "./BuildNodes.css";

import {
  createDefaultLimitOrderTree,
  createDefaultPriceConditionTree,
  parseConditionTree,
  validatePriceConditionTree,
  validatePriceConditionTreeRaw,
  type ConditionNode,
  PYTH_PRICE_FEED_IDS,
} from "../../../lib/limitOrderTree";
import { BRIDGE_ASSET_OPTIONS, BRIDGE_VAULT_OPTIONS } from "../../../lib/v3/vaultBridgeLeg";
import {
  bridgeDestDisclaimer,
  bridgeDestOptionLabel,
  bridgeDestsFrom,
  isBridgeVaultChain,
  isValidDestAddress,
  payoutDestFor,
  vaultLabel,
} from "../../../lib/bridge/hub";
import { getSelectedChainId } from "../../../lib/networks";

export type LimitOrderSegment =
  | { type: "and"; leaves: ConditionNode[] }
  | { type: "or"; leaf: ConditionNode };

function extractPriceLeaves(node: ConditionNode): ConditionNode[] {
  return (node.conditions ?? []).filter((c) => c.op === "LEAF");
}

export function parseLimitOrderSegments(raw: unknown): LimitOrderSegment[] {
  const tree = parseConditionTree(raw);
  if (tree.op === "AND") {
    const leaves = extractPriceLeaves(tree);
    return [{ type: "and", leaves: leaves.length ? leaves : [createDefaultPriceConditionTree()] }];
  }
  if (tree.op === "OR") {
    const segments: LimitOrderSegment[] = [];
    for (const child of tree.conditions ?? []) {
      if (child.op === "AND") {
        const leaves = extractPriceLeaves(child);
        if (leaves.length) segments.push({ type: "and", leaves });
      } else if (child.op === "LEAF") {
        segments.push({ type: "or", leaf: child });
      }
    }
    if (!segments.length) {
      return [{ type: "and", leaves: [createDefaultPriceConditionTree()] }];
    }
    return segments;
  }
  if (tree.op === "LEAF") {
    return [{ type: "and", leaves: [tree] }];
  }
  return [{ type: "and", leaves: [createDefaultPriceConditionTree()] }];
}

export { validatePriceConditionTreeRaw, validatePriceConditionTree, parseConditionTree };
export type { ConditionNode };
export { PYTH_PRICE_FEED_IDS, createDefaultLimitOrderTree, createDefaultPriceConditionTree };

export function segmentsToConditionTree(segments: LimitOrderSegment[]): ConditionNode {
  if (!segments.length) {
    return createDefaultLimitOrderTree();
  }
  if (segments.length === 1 && segments[0].type === "and") {
    return { op: "AND", conditions: segments[0].leaves };
  }
  return {
    op: "OR",
    conditions: segments.map((seg) =>
      seg.type === "and" ? { op: "AND", conditions: seg.leaves } : seg.leaf
    ),
  };
}

// Production: Base mainnet (8453). Legacy testnet labels map for saved scenes.
export const CHAIN_LABEL_TO_ID: Record<string, string> = {
  Base: "8453",
  "Base Mainnet": "8453",
  Sepolia: "11155111",
  ETH: "11155111",
  "ETH Testnet": "11155111",
  Ethereum: "11155111",
  "Ethereum Sepolia": "11155111",
  "Base Sepolia": "84532",
  Arbitrum: "42161",
  // NETWORKS[42161].name — Discover presets stamp getNetwork().name into nodes, and a miss here
  // silently resolves to 8453, which sends Arbitrum arming down the v2 path.
  "Arbitrum One": "42161",
  "Tempo Testnet": "42431",
  "Tempo Moderato": "42431",
  Moderato: "42431",
  "Hyperliquid Testnet": "998",
  "HyperEVM Testnet": "998",
  HyperEVM: "998",
  Optimism: "10",
  Polygon: "137",
  Solana: "solana",
  Zcash: "zcash",
};

export function chainLabelToId(chain?: string | null): string {
  if (!chain) return "8453";
  const normalized = chain.trim();
  if (CHAIN_LABEL_TO_ID[normalized]) return CHAIN_LABEL_TO_ID[normalized];
  const ci = Object.keys(CHAIN_LABEL_TO_ID).find(k => k.toLowerCase() === normalized.toLowerCase());
  if (ci) return CHAIN_LABEL_TO_ID[ci];
  if (normalized === "solana" || normalized === "zcash" || /^\d+$/.test(normalized)) return normalized;
  return "8453";
}

export function validateRecipientAddress(address: string, toChain: string): string | null {
  if (!address) return "Recipient address required";
  const EVM_CHAIN_IDS = ["1", "11155111", "84532", "42161", "10", "8453", "137", "42431", "998"];
  const EVM_REGEX = /^0x[0-9a-fA-F]{40}$/;
  const SOLANA_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  if (toChain === "solana") {
    return SOLANA_REGEX.test(address) ? null : "Invalid Solana address (Base58, 32-44 chars)";
  }
  if (toChain === "zcash") {
    return isValidDestAddress("zcash", address)
      ? null
      : "Invalid Zcash address (t1/t3 or u1 — not zs1)";
  }
  if (EVM_CHAIN_IDS.includes(toChain)) {
    return EVM_REGEX.test(address) ? null : "Invalid EVM address (0x + 40 hex)";
  }
  return "Unknown destination chain";
}

// Node input fields that must accept digits + a single decimal point only (see handleChange).
const NUMERIC_NODE_FIELDS = new Set<string>([
  'amount', 'toAmount', 'priceGoal', 'positionPct', 'rangeLow', 'rangeHigh',
  'gridLevels', 'sliceCount', 'intervalSeconds', 'maxSlippageBps', 'scheduleValue', 'repeatCount',
]);

/** Keep digits and at most one decimal point; drop everything else ("1a.2.3" → "1.23"). */
export function sanitizeNumericInput(value: string): string {
  const cleaned = value.replace(/[^0-9.]/g, '');
  const dot = cleaned.indexOf('.');
  return dot === -1 ? cleaned : cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, '');
}

interface NodeData {
  label?: string;
  type?: 'deposit' | 'withdraw' | 'swap' | 'lend' | 'strategy' | 'control' | 'bridge';
  coin?: string;
  toCoin?: string;
  amount?: string;
  toAmount?: string;
  chain?: string;
  toChain?: string;
  dex?: string;
  strategy?: string;
  lendAction?: 'enter' | 'exit' | string;
  /** Jupiter Earn vs Jito liquid stake (both use the lend node shape). */
  lendVenue?: 'jupiter' | 'jito' | string;
  wallet?: string;
  amountSource?: 'fixed' | 'output';
  linkedFromNodeId?: string | null;
  priceGoal?: string;
  intervals?: string;
  useTree?: string;
  conditionTree?: string;
  controlKind?: string;
  scheduleValue?: string;
  scheduleUnit?: string;
  repeatCount?: string;
  [key: string]: unknown;
}

function getScheduleFields(data: NodeData): { value: string; unit: ScheduleUnit } {
  if (data.scheduleValue != null && String(data.scheduleValue).trim() !== "") {
    return {
      value: String(data.scheduleValue),
      unit: (data.scheduleUnit as ScheduleUnit) || "seconds",
    };
  }
  return displayScheduleFromSeconds(data.intervalSeconds as string);
}

function PriceLeafRow({
  leaf,
  onChange,
  onDelete,
}: {
  leaf: ConditionNode;
  onChange: (leaf: ConditionNode) => void;
  onDelete?: () => void;
}) {
  const handleLeafChange = (field: string, value: string | number) => {
    const updated = { ...leaf, [field]: value };
    if (field === "asset") {
      updated.price_feed_id = PYTH_PRICE_FEED_IDS[value as string] || "";
    }
    onChange(updated);
  };

  return (
    <div className="limit-order-leaf-row">
      <select
        className="node-select limit-order-asset"
        value={leaf.asset || 'ETH'}
        onChange={(e) => handleLeafChange('asset', e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onFocus={(e) => e.stopPropagation()}
      >
        <option value="ETH">ETH</option>
        <option value="BTC">BTC</option>
        <option value="SOL">SOL</option>
        <option value="USDC">USDC</option>
      </select>
      <select
        className="node-select limit-order-cmp"
        value={leaf.condition || 'LTE'}
        onChange={(e) => handleLeafChange('condition', e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onFocus={(e) => e.stopPropagation()}
      >
        <option value="LTE">≤</option>
        <option value="GTE">≥</option>
      </select>
      <input
        type="text"
        inputMode="decimal"
        className="node-input limit-order-price"
        placeholder="Price (e.g. 3000)"
        value={leaf.bound === undefined ? '' : leaf.bound}
        // Keep the RAW (sanitized) string while typing: parseFloat("0.")||0 collapses to 0 and the
        // controlled value snaps back, erasing the decimal point so fractional prices can't be typed.
        // sanitizeNumericInput keeps digits + one dot; validatePriceConditionTree coerces & rejects <=0.
        onChange={(e) => handleLeafChange('bound', sanitizeNumericInput(e.target.value))}
        onMouseDown={(e) => e.stopPropagation()}
        onFocus={(e) => e.stopPropagation()}
      />
      {onDelete ? (
        <button
          type="button"
          className="limit-order-delete"
          onClick={onDelete}
          onMouseDown={(e) => e.stopPropagation()}
        >
          ✕
        </button>
      ) : (
        <span className="limit-order-delete-spacer" aria-hidden />
      )}
    </div>
  );
}

function OrDivider() {
  return (
    <div className="limit-order-or-divider">OR</div>
  );
}

function LimitOrderPriceEditor({
  conditionTreeRaw,
  onChangeTree,
}: {
  conditionTreeRaw: string | undefined;
  onChangeTree: (json: string) => void;
}) {
  const segments = parseLimitOrderSegments(conditionTreeRaw);
  const lastSegment = segments[segments.length - 1];
  const andModeActive = lastSegment?.type === "and";

  const commit = (next: LimitOrderSegment[]) => {
    onChangeTree(JSON.stringify(segmentsToConditionTree(next)));
  };

  const addAnd = () => {
    const next = [...segments];
    const lastIndex = next.length - 1;
    const last = next[lastIndex];

    if (last?.type === "and") {
      next[lastIndex] = {
        type: "and",
        leaves: [...last.leaves, createDefaultPriceConditionTree()],
      };
    } else if (last?.type === "or") {
      next[lastIndex] = {
        type: "and",
        leaves: [last.leaf, createDefaultPriceConditionTree()],
      };
    } else {
      next.push({ type: "and", leaves: [createDefaultPriceConditionTree()] });
    }
    commit(next);
  };

  const addOr = () => {
    const next = [...segments];
    if (next.length === 1 && next[0].type === "and") {
      next.push({ type: "or", leaf: createDefaultPriceConditionTree() });
    } else {
      next.push({ type: "or", leaf: createDefaultPriceConditionTree() });
    }
    commit(next);
  };

  const updateAndLeaf = (segIndex: number, leafIndex: number, leaf: ConditionNode) => {
    const next = [...segments];
    const seg = next[segIndex];
    if (seg.type !== "and") return;
    const leaves = [...seg.leaves];
    leaves[leafIndex] = leaf;
    next[segIndex] = { type: "and", leaves };
    commit(next);
  };

  const removeAndLeaf = (segIndex: number, leafIndex: number) => {
    const next = [...segments];
    const seg = next[segIndex];
    if (seg.type !== "and") return;
    const leaves = seg.leaves.filter((_, i) => i !== leafIndex);
    if (!leaves.length) {
      if (next.length === 1) {
        leaves.push(createDefaultPriceConditionTree());
      } else {
        next.splice(segIndex, 1);
        commit(next);
        return;
      }
    }
    next[segIndex] = { type: "and", leaves };
    commit(next);
  };

  const updateOrLeaf = (segIndex: number, leaf: ConditionNode) => {
    const next = [...segments];
    next[segIndex] = { type: "or", leaf };
    commit(next);
  };

  const removeOrSegment = (segIndex: number) => {
    if (segments.length <= 1) return;
    commit(segments.filter((_, i) => i !== segIndex));
  };

  const combinatorBtnStyle = (active: boolean) => ({
    flex: 1,
    background: active ? 'rgba(255, 193, 7, 0.3)' : 'rgba(255, 255, 255, 0.05)',
    color: 'white',
    border: active ? '1px solid #ffc107' : '1px solid rgba(255, 255, 255, 0.15)',
    borderRadius: '4px',
    fontSize: '10px',
    padding: '6px 4px',
    cursor: 'pointer',
    fontWeight: 'bold' as const,
    fontFamily: 'monospace',
  });

  return (
    <div onMouseDown={(e) => e.stopPropagation()}>
      <div className="limit-order-conditions">
        {segments.map((seg, segIndex) => (
          <div key={segIndex}>
            {segIndex > 0 && <OrDivider />}
            {seg.type === "and" ? (
              <div className="limit-order-and-block">
                {seg.leaves.map((leaf, leafIndex) => (
                  <div key={leafIndex}>
                    {leafIndex > 0 && <div className="limit-order-and-separator" />}
                    <PriceLeafRow
                      leaf={leaf}
                      onChange={(updated) => updateAndLeaf(segIndex, leafIndex, updated)}
                      onDelete={
                        seg.leaves.length > 1 || segments.length > 1
                          ? () => removeAndLeaf(segIndex, leafIndex)
                          : undefined
                      }
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="limit-order-or-block">
                <PriceLeafRow
                  leaf={seg.leaf}
                  onChange={(updated) => updateOrLeaf(segIndex, updated)}
                  onDelete={segments.length > 1 ? () => removeOrSegment(segIndex) : undefined}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '4px' }}>
        <button type="button" onClick={addAnd} style={combinatorBtnStyle(andModeActive)}>
          + AND
        </button>
        <button type="button" onClick={addOr} style={combinatorBtnStyle(!andModeActive)}>
          + OR
        </button>
      </div>
    </div>
  );
}

const tokens = ['ETH', 'USDC', 'SOL', 'USDT', 'WBTC', 'XMR'];

interface CustomNodeProps {
  data: NodeData;
  id: string;
  parentId?: string;
  updateNodeData?: (nodeId: string, field: string, value: string) => void;
  tokens?: string[];
  isTokenActive?: (token: string) => boolean;
  simStatus?: SimHighlightStatus;
  simShaking?: boolean;
  simExiting?: boolean;
}

function TreeBuilderNode({
  node,
  onChange,
  onDelete,
  pricesOnly = false,
}: {
  node: ConditionNode;
  onChange: (newNode: ConditionNode) => void;
  onDelete?: () => void;
  pricesOnly?: boolean;
}) {
  const handleOpChange = (newOp: "LEAF" | "AND" | "OR" | "NOT") => {
    if (pricesOnly && newOp === "NOT") return;
    if (newOp === "LEAF") {
      onChange({
        op: "LEAF",
        asset: "ETH",
        condition: "LTE",
        bound: 1500,
        price_feed_id: PYTH_PRICE_FEED_IDS.ETH
      });
    } else if (newOp === "NOT") {
      onChange({
        op: "NOT",
        conditions: [
          {
            op: "LEAF",
            asset: "ETH",
            condition: "LTE",
            bound: 1500,
            price_feed_id: PYTH_PRICE_FEED_IDS.ETH
          }
        ]
      });
    } else {
      onChange({
        op: newOp,
        conditions: [
          {
            op: "LEAF",
            asset: "ETH",
            condition: "LTE",
            bound: 1500,
            price_feed_id: PYTH_PRICE_FEED_IDS.ETH
          }
        ]
      });
    }
  };

  const handleLeafChange = (field: string, value: string | number) => {
    const updated = { ...node, [field]: value };
    if (field === "asset") {
      updated.price_feed_id = PYTH_PRICE_FEED_IDS[value as string] || "";
    }
    onChange(updated);
  };

  const handleChildChange = (index: number, newChild: ConditionNode) => {
    const newConditions = [...(node.conditions || [])];
    newConditions[index] = newChild;
    onChange({ ...node, conditions: newConditions });
  };

  const handleAddChild = (childOp: "LEAF" | "AND" | "OR") => {
    const newChild: ConditionNode = childOp === "LEAF"
      ? {
          op: "LEAF",
          asset: "ETH",
          condition: "LTE",
          bound: 1500,
          price_feed_id: PYTH_PRICE_FEED_IDS.ETH
        }
      : {
          op: childOp,
          conditions: []
        };
    onChange({
      ...node,
      conditions: [...(node.conditions || []), newChild]
    });
  };

  const handleRemoveChild = (index: number) => {
    const newConditions = (node.conditions || []).filter((_, i) => i !== index);
    onChange({ ...node, conditions: newConditions });
  };

  return (
    <div className="tree-builder-node" style={{
      border: '1px solid rgba(255, 255, 255, 0.08)',
      borderRadius: '6px',
      padding: '8px',
      marginTop: '6px',
      background: 'rgba(0, 0, 0, 0.2)',
      textAlign: 'left'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <select
          value={node.op}
          onChange={(e) => handleOpChange(e.target.value as "LEAF" | "AND" | "OR" | "NOT")}
          style={{
            background: '#222',
            color: 'white',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '4px',
            fontSize: '11px',
            padding: '2px 4px',
            fontFamily: 'monospace'
          }}
        >
          <option value="LEAF">Price</option>
          <option value="AND">AND (all)</option>
          <option value="OR">OR (any)</option>
          {!pricesOnly && <option value="NOT">NOT Wrap</option>}
        </select>

        {onDelete && (
          <button
            onClick={onDelete}
            style={{
              background: 'transparent',
              color: '#ff6b6b',
              border: 'none',
              cursor: 'pointer',
              fontSize: '12px',
              padding: '0px 4px',
              fontWeight: 'bold'
            }}
          >
            ✕
          </button>
        )}
      </div>

      {node.op === "LEAF" ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
          <div style={{ display: 'flex', gap: '4px' }}>
            <select
              value={node.asset || 'ETH'}
              onChange={(e) => handleLeafChange('asset', e.target.value)}
              style={{
                background: '#333',
                color: 'white',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '4px',
                fontSize: '11px',
                flex: 1,
                padding: '3px',
                fontFamily: 'monospace'
              }}
            >
              <option value="ETH">ETH</option>
              <option value="BTC">BTC</option>
              <option value="SOL">SOL</option>
              <option value="USDC">USDC</option>
            </select>
            
            <select
              value={node.condition || 'LTE'}
              onChange={(e) => handleLeafChange('condition', e.target.value)}
              style={{
                background: '#333',
                color: 'white',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '4px',
                fontSize: '11px',
                width: '60px',
                padding: '3px',
                fontFamily: 'monospace'
              }}
            >
              <option value="LTE">≤</option>
              <option value="GTE">≥</option>
            </select>
          </div>
          
          <input
            type="text"
            inputMode="decimal"
            placeholder="Price limit (e.g. 3000)"
            value={node.bound === undefined ? '' : node.bound}
            // Raw sanitized string — see PriceLeafRow: parseFloat()||0 erases the decimal point.
            onChange={(e) => handleLeafChange('bound', sanitizeNumericInput(e.target.value))}
            style={{
              background: '#333',
              color: 'white',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '4px',
              fontSize: '11px',
              padding: '3px 6px',
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: 'monospace'
            }}
          />
        </div>
      ) : (
        <div style={{ paddingLeft: '8px', borderLeft: '1px dashed rgba(255, 255, 255, 0.15)', marginTop: '6px' }}>
          {node.conditions?.map((child, idx) => (
            <TreeBuilderNode
              key={idx}
              node={child}
              pricesOnly={pricesOnly}
              onChange={(newChild) => handleChildChange(idx, newChild)}
              onDelete={() => handleRemoveChild(idx)}
            />
          ))}

          {node.op !== "NOT" && (
            <div style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
              <button
                onClick={() => handleAddChild('LEAF')}
                style={{
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  fontSize: '9px',
                  padding: '3px 6px',
                  cursor: 'pointer',
                  flex: 1,
                  fontFamily: 'monospace'
                }}
              >
                {pricesOnly ? '+ Price' : '+ Add Limit'}
              </button>
              <button
                onClick={() => handleAddChild('AND')}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  fontSize: '9px',
                  padding: '3px 6px',
                  cursor: 'pointer',
                  flex: 1,
                  fontFamily: 'monospace'
                }}
              >
                {pricesOnly ? '+ AND' : '+ Add Group'}
              </button>
              {pricesOnly && (
                <button
                  onClick={() => handleAddChild('OR')}
                  style={{
                    background: 'rgba(255, 255, 255, 0.05)',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    fontSize: '9px',
                    padding: '3px 6px',
                    cursor: 'pointer',
                    flex: 1,
                    fontFamily: 'monospace'
                  }}
                >
                  + OR
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CustomNode({ data, id, parentId, updateNodeData, tokens: propTokens = tokens, isTokenActive, simStatus, simShaking, simExiting }: CustomNodeProps) {
  const handleChange = (field: string, value: string) => {
    if ((field === 'coin' || field === 'toCoin') && value && isTokenActive && !isTokenActive(value)) {
      return;
    }
    // Amount/price/param boxes accept digits + a single decimal point only (strip letters etc.).
    // Excludes free-text fields: wallet (address), intervals ("1 day"), and dropdown-backed fields.
    if (NUMERIC_NODE_FIELDS.has(field)) value = sanitizeNumericInput(value);
    if (updateNodeData) {
      updateNodeData(id, field, value);
    }
  };

  const typeModifier =
    data.type === 'strategy'
      ? 'custom-node--strategy'
      : data.type === 'control'
        ? 'custom-node--control'
        : '';

  return (
    <div
      className={[
        'custom-node',
        typeModifier,
        parentId ? 'custom-node--in-group' : '',
        simHighlightClass(simStatus, simShaking, simExiting),
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-content">
        <div className="node-title">{data.label}</div>
        
        {data.type === 'deposit' && (
          <div className="node-inputs">
            <div className="node-input-row">
              <select
                className="node-select"
                value={data.coin || ''}
                onChange={(e) => handleChange('coin', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              >
                <option value="" disabled hidden>Coin</option>
                {propTokens.map(token => {
                  const active = isTokenActive ? isTokenActive(token) : true;
                  return (
                    <option key={token} value={token} disabled={!active} className={!active ? 'inactive-token' : ''}>
                      {token}
                    </option>
                  );
                })}
              </select>
              <input
                type="text"
                inputMode="decimal"
                className="node-input node-input--amount"
                placeholder="Amount"
                value={data.amount || ''}
                onChange={(e) => handleChange('amount', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        )}

        {data.type === 'bridge' && (
          <div className="node-inputs">
            <div className="node-input-row">
              <select
                className="node-select"
                value={data.chain || ''}
                onChange={(e) => {
                  handleChange('chain', e.target.value);
                  handleChange('label', `Bridge → ${data.toChain || 'vault'}`);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              >
                <option value="" disabled hidden>From vault</option>
                {BRIDGE_VAULT_OPTIONS.map((o) => (
                  <option key={o.chainId} value={o.label}>{o.label}</option>
                ))}
              </select>
              <select
                className="node-select"
                value={data.toChain || ''}
                onChange={(e) => {
                  handleChange('toChain', e.target.value);
                  handleChange('label', `Bridge → ${e.target.value}`);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              >
                <option value="" disabled hidden>To vault</option>
                {BRIDGE_VAULT_OPTIONS.map((o) => (
                  <option key={o.chainId} value={o.label}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="node-input-row">
              <select
                className="node-select"
                value={data.coin || 'USDC'}
                onChange={(e) => handleChange('coin', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              >
                {BRIDGE_ASSET_OPTIONS.map((sym) => (
                  <option key={sym} value={sym}>{sym}</option>
                ))}
              </select>
              <input
                type="text"
                inputMode="decimal"
                className="node-input node-input--amount"
                placeholder="Amount"
                value={data.amount || ''}
                onChange={(e) => handleChange('amount', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        )}

        {data.type === 'swap' && (
          <div className="node-inputs">
            <div className="node-input-row">
              <select
                className="node-select"
                value={data.coin || ''}
                onChange={(e) => handleChange('coin', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              >
                <option value="" disabled hidden>From</option>
                {propTokens.map(token => {
                  const active = isTokenActive ? isTokenActive(token) : true;
                  return (
                    <option key={token} value={token} disabled={!active} className={!active ? 'inactive-token' : ''}>
                      {token}
                    </option>
                  );
                })}
              </select>
              <input
                type="text"
                inputMode="decimal"
                className="node-input node-input--amount"
                placeholder="Amount"
                value={data.amount || ''}
                onChange={(e) => handleChange('amount', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              />
            </div>
            <div className="node-input-row">
              <select
                className="node-select"
                value={data.toCoin || ''}
                onChange={(e) => handleChange('toCoin', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              >
                <option value="" disabled hidden>To</option>
                {propTokens.map(token => {
                  const active = isTokenActive ? isTokenActive(token) : true;
                  return (
                    <option key={token} value={token} disabled={!active} className={!active ? 'inactive-token' : ''}>
                      {token}
                    </option>
                  );
                })}
              </select>
              <input
                type="text"
                className="node-input node-input--amount"
                placeholder="Output"
                value={data.toAmount || ''}
                readOnly
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        )}

        {data.type === 'lend' && (
          <div className="node-inputs">
            <div className="node-input-row">
              <select
                className="node-select"
                value={data.lendAction === 'exit' ? 'exit' : 'enter'}
                onChange={(e) => {
                  const action = e.target.value === 'exit' ? 'exit' : 'enter';
                  const jito = data.lendVenue === 'jito';
                  handleChange('lendAction', action);
                  handleChange('coin', jito ? (action === 'enter' ? 'SOL' : 'JitoSOL') : action === 'enter' ? 'USDC' : 'jlUSDC');
                  handleChange('toCoin', jito ? (action === 'enter' ? 'JitoSOL' : 'SOL') : action === 'enter' ? 'jlUSDC' : 'USDC');
                  handleChange(
                    'label',
                    jito
                      ? action === 'enter'
                        ? 'Stake (Jito)'
                        : 'Unstake (Jito)'
                      : action === 'enter'
                        ? 'Earn Enter (Jupiter)'
                        : 'Earn Exit (Jupiter)',
                  );
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              >
                {data.lendVenue === 'jito' ? (
                  <>
                    <option value="enter">Stake — SOL → JitoSOL</option>
                    <option value="exit">Unstake — JitoSOL → SOL</option>
                  </>
                ) : (
                  <>
                    <option value="enter">Enter — USDC → jlUSDC</option>
                    <option value="exit">Exit — jlUSDC → USDC</option>
                  </>
                )}
              </select>
              <input
                type="text"
                inputMode="decimal"
                className="node-input node-input--amount"
                placeholder="Amount"
                value={data.amount || ''}
                onChange={(e) => handleChange('amount', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        )}

        {data.type === 'withdraw' && (() => {
          const isLinked = Boolean(data.linkedFromNodeId);
          const amount = (data.amount as string) || '';
          const usesAllOutput = isLinked && !amount.trim();
          const vaultChainId = getSelectedChainId();
          const homeLabel = vaultLabel(vaultChainId);
          const payoutDest = payoutDestFor(vaultChainId, data.chain as string | undefined);
          const destNote = bridgeDestDisclaimer(payoutDest);

          return (
          <div className="node-inputs">
            <div className="node-input-row node-input-row--withdraw">
              <select
                className="node-select"
                value={data.coin || ''}
                onChange={(e) => handleChange('coin', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              >
                <option value="" disabled hidden>Coin</option>
                {propTokens.map(token => {
                  const active = isTokenActive ? isTokenActive(token) : true;
                  return (
                    <option key={token} value={token} disabled={!active} className={!active ? 'inactive-token' : ''}>
                      {token}
                    </option>
                  );
                })}
              </select>
              <input
                type="text"
                inputMode="decimal"
                className={`node-input${usesAllOutput ? ' node-input--output' : ' node-input--amount'}`}
                placeholder={isLinked ? 'Output (all)' : 'Amount'}
                value={amount}
                onChange={(e) => handleChange('amount', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              />
            </div>
            {isBridgeVaultChain(vaultChainId) && (
              <div className="node-input-row node-input-row--withdraw">
                <select
                  className="node-select"
                  value={(data.chain as string) || homeLabel}
                  onChange={(e) => handleChange('chain', e.target.value)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onFocus={(e) => e.stopPropagation()}
                >
                  <option value={homeLabel}>{homeLabel} — keep private</option>
                  {bridgeDestsFrom(vaultChainId).map((d) => (
                    <option key={d.id} value={d.label}>{bridgeDestOptionLabel(d)}</option>
                  ))}
                </select>
              </div>
            )}
            {destNote && <p className="node-hint">{destNote}</p>}
            <div className="node-input-row node-input-row--withdraw">
              <input
                type="text"
                className="node-input node-input--wallet"
                placeholder={
                  payoutDest?.kind === "zcash"
                    ? "t1… / t3… / u1… Zcash address"
                    : payoutDest
                      ? `Your ${data.chain} address`
                      : "Your wallet (note owner — stays in vault)"
                }
                value={data.wallet || ''}
                onChange={(e) => handleChange('wallet', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
              />
            </div>
          </div>
          );
        })()}

        {data.type === 'strategy' && (() => {
          const strategyKind = normalizeStrategyKind((data.strategy as string) || undefined);

          if (strategyKind === 'Limit Order') {
            return (
              <div className="node-inputs">
                <LimitOrderPriceEditor
                  conditionTreeRaw={data.conditionTree as string | undefined}
                  onChangeTree={(json) => handleChange('conditionTree', json)}
                />
              </div>
            );
          }

          if (strategyKind === 'Stop Loss' || strategyKind === 'Take Profit') {
            return (
              <div className="node-inputs">
                <input
                  type="text"
                  className="node-input"
                  placeholder={strategyKind === 'Stop Loss' ? 'Stop price (e.g. 2800)' : 'Target price (e.g. 3000)'}
                  value={data.priceGoal || ''}
                  onChange={(e) => handleChange('priceGoal', e.target.value)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onFocus={(e) => e.stopPropagation()}
                />
                <input
                  type="text"
                  className="node-input"
                  placeholder="% of position (default 100)"
                  value={(data.positionPct as string) || ''}
                  onChange={(e) => handleChange('positionPct', e.target.value)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onFocus={(e) => e.stopPropagation()}
                />
              </div>
            );
          }

          return (
          <div className="node-inputs">
                {data.strategy === 'Range' && (
                  <>
                    <input type="text" className="node-input" placeholder="Range low (e.g. 1500)"
                      value={(data.rangeLow as string) || ''} onChange={(e) => handleChange('rangeLow', e.target.value)} onMouseDown={(e) => e.stopPropagation()} />
                    <input type="text" className="node-input" placeholder="Range high (e.g. 1800)"
                      value={(data.rangeHigh as string) || ''} onChange={(e) => handleChange('rangeHigh', e.target.value)} onMouseDown={(e) => e.stopPropagation()} />
                    <input type="text" className="node-input" placeholder="Grid levels (e.g. 4)"
                      value={(data.gridLevels as string) || ''} onChange={(e) => handleChange('gridLevels', e.target.value)} onMouseDown={(e) => e.stopPropagation()} />
                  </>
                )}

                {data.strategy === 'TWAP' && (
                  <>
                    <input type="text" className="node-input" placeholder="Slices (e.g. 3)"
                      value={(data.sliceCount as string) || ''} onChange={(e) => handleChange('sliceCount', e.target.value)} onMouseDown={(e) => e.stopPropagation()} />
                    <input type="text" className="node-input" placeholder="Interval seconds (e.g. 60)"
                      value={(data.intervalSeconds as string) || ''} onChange={(e) => handleChange('intervalSeconds', e.target.value)} onMouseDown={(e) => e.stopPropagation()} />
                    <input type="text" className="node-input" placeholder="Max slippage bps (e.g. 100)"
                      value={(data.maxSlippageBps as string) || ''} onChange={(e) => handleChange('maxSlippageBps', e.target.value)} onMouseDown={(e) => e.stopPropagation()} />
                  </>
                )}

                {data.strategy === 'DCA' && (
                  <>
                    <input type="text" className="node-input" placeholder="Buys count (e.g. 5)"
                      value={(data.sliceCount as string) || ''} onChange={(e) => handleChange('sliceCount', e.target.value)} onMouseDown={(e) => e.stopPropagation()} />
                    <input type="text" className="node-input" placeholder="Every (e.g. 1 day)"
                      value={(data.intervals as string) || ''} onChange={(e) => handleChange('intervals', e.target.value)} onMouseDown={(e) => e.stopPropagation()} />
                  </>
                )}
          </div>
          );
        })()}

        {data.type === 'control' && (
          <div className="node-inputs">
            {((data.controlKind as string) || '').toLowerCase() === 'schedule' && (() => {
              const afterFields = getScheduleFields(data);
              return (
                <div className="node-input-row node-input-row--schedule">
                  <span className="node-schedule-prefix">After</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    className="node-input node-input--schedule-value"
                    placeholder="0"
                    value={afterFields.value}
                    onChange={(e) => handleChange('scheduleValue', e.target.value)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onFocus={(e) => e.stopPropagation()}
                  />
                  <select
                    className="node-select node-select--unit"
                    value={afterFields.unit}
                    onChange={(e) => handleChange('scheduleUnit', e.target.value)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onFocus={(e) => e.stopPropagation()}
                  >
                    <option value="blocks">Blocks</option>
                    <option value="seconds">Seconds</option>
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                  </select>
                </div>
              );
            })()}
            {((data.controlKind as string) || '').toLowerCase() === 'tempo dex' && (
              <p className="node-hint">
                After Withdraw to Tempo: swap TIP-20 stables on the enshrined DEX (USDC.e ↔ pathUSD / Alpha…).
                User-signed on Tempo — not a Siphon vault swap. Use the dash Tempo panel to execute.
              </p>
            )}
            {((data.controlKind as string) || '').toLowerCase() === 'tempo zone' && (
              <p className="node-hint">
                After funds are on Tempo: deposit into a Zone for explorer-private balances (operator can still see).
                Sandbox Zones run on Moderato — dash Tempo panel → Zone deposit.
              </p>
            )}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
