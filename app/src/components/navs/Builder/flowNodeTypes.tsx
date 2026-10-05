"use client";

import { createContext, memo, useContext, type ReactNode } from "react";
import type { NodeProps } from "@xyflow/react";
import { CustomNode } from "./BuildNodes";
import { RepeatGroupNode } from "./RepeatGroupNode";
import { useEthPrice } from "@/lib/useEthPrice";

import type { SimHighlightStatus } from "./useCanvasSimulation";

export interface BuildFlowContextValue {
  updateNodeData: (nodeId: string, field: string, value: string) => void;
  tokens: string[];
  isTokenActive: (token: string) => boolean;
  simHighlight?: Record<string, SimHighlightStatus>;
  simShakingId?: string | null;
  simExiting?: boolean;
}

const BuildFlowContext = createContext<BuildFlowContextValue | null>(null);

export function BuildFlowContextProvider({
  value,
  children,
}: {
  value: BuildFlowContextValue;
  children: ReactNode;
}) {
  return <BuildFlowContext.Provider value={value}>{children}</BuildFlowContext.Provider>;
}

function CustomNodeFlow(props: NodeProps) {
  const ctx = useContext(BuildFlowContext);
  if (!ctx) return null;
  return (
    <CustomNode
      id={props.id}
      parentId={props.parentId}
      data={props.data}
      updateNodeData={ctx.updateNodeData}
      tokens={ctx.tokens}
      isTokenActive={ctx.isTokenActive}
      simStatus={ctx.simHighlight?.[props.id]}
      simShaking={ctx.simShakingId === props.id}
      simExiting={ctx.simExiting}
    />
  );
}

function RepeatGroupFlow(props: NodeProps) {
  const ctx = useContext(BuildFlowContext);
  if (!ctx) return null;
  return (
    <RepeatGroupNode
      id={props.id}
      data={props.data}
      selected={props.selected}
      updateNodeData={ctx.updateNodeData}
      simStatus={ctx.simHighlight?.[props.id]}
      simShaking={ctx.simShakingId === props.id}
      simExiting={ctx.simExiting}
    />
  );
}

// Decorative live-price widget node (no handles, not part of the run plan — graphRunPlan filters
// by data.type so this is ignored by the compiler). useEthPrice self-polls, so it updates live.
function PriceWidgetFlow() {
  const ethUsd = useEthPrice();
  const eth2usdc = ethUsd ? ethUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  const usdc2eth = ethUsd ? (1 / ethUsd).toFixed(6) : '—';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 5,
      padding: '10px 14px', borderRadius: 10, minWidth: 160,
      background: 'rgba(18,18,18,0.92)', border: '1px solid rgba(255,255,255,0.12)',
      font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
      color: 'rgba(255,255,255,0.78)', letterSpacing: '0.02em',
      boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
    }}>
      <span style={{ fontSize: 9, letterSpacing: '0.14em', color: 'var(--build-ui-text-subtle)' }}>LIVE PRICE</span>
      <span>1 ETH&nbsp;&nbsp;→ {eth2usdc} <span style={{ opacity: 0.5 }}>USDC</span></span>
      <span>1 USDC → {usdc2eth} <span style={{ opacity: 0.5 }}>ETH</span></span>
    </div>
  );
}

// Decorative "rules to remember" reference card (no handles, not part of the run plan — the
// compiler filters by data.type, and this node carries none, so it's ignored like PriceWidget).
function RulesNodeFlow() {
  const rules = [
    'Keep gas + 0.25 USDC in your wallet (fee is non-refundable)',
    'Limit / Stop / Take-Profit spend your vault balance',
    'TWAP / DCA / Grid deposit the full amount fresh from your wallet',
    'TWAP / DCA / Grid: 2–8 legs max',
  ];
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '12px 14px', borderRadius: 10, maxWidth: 264,
      background: 'rgba(18,18,18,0.92)', border: '1px solid rgba(255,255,255,0.12)',
      font: '10px ui-monospace, SFMono-Regular, Menlo, monospace',
      color: 'rgba(255,255,255,0.72)', letterSpacing: '0.02em', lineHeight: 1.4,
      boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
    }}>
      <span style={{ fontSize: 9, letterSpacing: '0.14em', color: 'var(--build-ui-text-subtle)' }}>RULES TO REMEMBER</span>
      {rules.map((r, i) => {
        const hi = r.startsWith('TWAP');
        return (
          <span key={i} style={{ display: 'flex', gap: 6, color: hi ? '#e0b341' : undefined, fontWeight: hi ? 600 : undefined }}>
            <span style={{ opacity: hi ? 0.85 : 0.5 }}>•</span><span>{r}</span>
          </span>
        );
      })}
    </div>
  );
}

export const FLOW_NODE_TYPES = {
  custom: memo(CustomNodeFlow),
  repeatGroup: memo(RepeatGroupFlow),
  priceWidget: memo(PriceWidgetFlow),
  rules: memo(RulesNodeFlow),
};
