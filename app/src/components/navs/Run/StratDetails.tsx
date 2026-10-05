"use client";

import { useState, useEffect, useRef } from "react";
import { ReactFlow, ReactFlowProvider, Background, Node, Edge, Handle, Position, ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import "./StratDetails.css";

interface NodeData {
  label?: string;
  type?: 'deposit' | 'swap' | 'withdraw' | 'strategy';
  coin?: string;
  toCoin?: string;
  amount?: string;
  strategy?: string;
  chain?: string;
}

interface StrategyData {
  name: string;
  author?: string;
  nodes: Node[];
  edges: Edge[];
  description?: string;
  chains?: string[];
  networks?: string[];
  usage?: number;
  profit?: string;
  cost?: number;
}

interface StratDetailsProps {
  isOpen: boolean;
  onClose: () => void;
  strategy: StrategyData | null;
  onEdit?: () => void;
  onRun?: () => void;
  onFavorite?: () => void;
  isFavorite?: boolean;
}

export default function StratDetails({
  isOpen,
  onClose,
  strategy,
  onEdit,
  onRun,
  onFavorite,
  isFavorite = false
}: StratDetailsProps) {
  const [modalStrategyNodes, setModalStrategyNodes] = useState<Node[]>([]);
  const [modalStrategyEdges, setModalStrategyEdges] = useState<Edge[]>([]);
  const [flowKey, setFlowKey] = useState(0);
  const [isFlowLoading, setIsFlowLoading] = useState(false);
  const flowRef = useRef<HTMLDivElement>(null);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);

  // Load strategy nodes when modal opens
  useEffect(() => {
    if (isOpen && strategy) {
      setIsFlowLoading(true);
      if (strategy.nodes && strategy.edges) {
        // Ensure nodes have proper structure
        const formattedNodes = strategy.nodes.map((node: Node) => ({
          ...node,
          type: node.type || 'custom',
          position: node.position || { x: 0, y: 0 }
        }));
        const formattedEdges = strategy.edges.map((edge: Edge) => ({
          ...edge,
          type: edge.type || 'smoothstep'
        }));
        setModalStrategyNodes(formattedNodes);
        setModalStrategyEdges(formattedEdges);
        setFlowKey(prev => prev + 1); // Force React Flow to re-render
      } else {
        setModalStrategyNodes([]);
        setModalStrategyEdges([]);
      }
      setIsFlowLoading(false);
    }
  }, [isOpen, strategy]);

  if (!isOpen || !strategy) return null;

  const depositNodes = modalStrategyNodes.filter(node => (node.data as NodeData)?.type === 'deposit');
  const strategyNodes = modalStrategyNodes.filter(node => (node.data as NodeData)?.type === 'strategy');
  
  // Get input coin from first deposit node, default to USDC
  const inputCoin = depositNodes.length > 0 && (depositNodes[0].data as NodeData)?.coin 
    ? (depositNodes[0].data as NodeData).coin 
    : 'USDC';
  
  // Output is input coin + Logic if strategy nodes exist
  const hasLogic = strategyNodes.length > 0;
  const outputText = hasLogic ? `${inputCoin} + Logic` : inputCoin;

  return (
    <div className="strategy-modal-overlay" onClick={onClose}>
      <div className="strategy-modal" onClick={(e) => e.stopPropagation()}>
        <div className="strategy-modal-header">
          <div className="strategy-modal-header-content">
            <div className="strategy-modal-header-main">
              <h2 className="strategy-modal-title">{strategy.name}</h2>
              {strategy.author && (
                <p className="strategy-modal-author">by {strategy.author}</p>
              )}
            </div>
            {(strategy.usage !== undefined || strategy.profit || strategy.cost !== undefined) && (
              <div className="strategy-modal-stats-top">
                {strategy.usage !== undefined && (
                  <div className="strategy-modal-stat-item">
                    <span className="strategy-modal-stat-label">Runs</span>
                    <span className="strategy-modal-stat-value">{strategy.usage}</span>
                  </div>
                )}
                {strategy.profit && (
                  <div className="strategy-modal-stat-item">
                    <span className="strategy-modal-stat-label">Profit</span>
                    <span className="strategy-modal-stat-value">{strategy.profit}</span>
                  </div>
                )}
                {strategy.cost !== undefined && (
                  <div className="strategy-modal-stat-item">
                    <span className="strategy-modal-stat-label">Cost of Run</span>
                    <span className="strategy-modal-stat-value">${strategy.cost.toFixed(4)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
          <button 
            className="strategy-modal-close"
            onClick={onClose}
            aria-label="Close modal"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        
        <div className="strategy-modal-content">
          <div className="strategy-modal-info">
            {(strategy.chains || strategy.networks) && (
              <div className="strategy-modal-categories">
                {strategy.chains?.map((chain: string, idx: number) => (
                  <span key={idx} className="strategy-modal-category-badge">
                    {chain.charAt(0).toUpperCase() + chain.slice(1)}
                  </span>
                ))}
                {strategy.networks?.map((network: string, idx: number) => (
                  <span key={`net-${idx}`} className="strategy-modal-network-badge">
                    {network}
                  </span>
                ))}
              </div>
            )}
            {strategy.description && (
              <p className="strategy-modal-description">{strategy.description}</p>
            )}
            
            {/* Input/Output Section */}
            {modalStrategyNodes.length > 0 && (
              <div className="strategy-modal-io-section">
                <div className="strategy-modal-io-content">
                  <div className="strategy-modal-io-inputs">
                    <div className="strategy-modal-io-title">Input</div>
                    <div className="strategy-modal-io-items">
                      <div className="strategy-modal-io-item">
                        <span className="strategy-modal-io-coin">{inputCoin}</span>
                      </div>
                    </div>
                  </div>
                  <div className="strategy-modal-io-arrow">→</div>
                  <div className="strategy-modal-io-outputs">
                    <div className="strategy-modal-io-title">Output</div>
                    <div className="strategy-modal-io-items">
                      <div className="strategy-modal-io-item">
                        <span className="strategy-modal-io-coin">{outputText}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
            
            <div className="strategy-modal-steps-section">
              <div className="strategy-modal-steps-header">
                <span className="strategy-modal-steps-label">Steps ({modalStrategyNodes.length || 0})</span>
              </div>
              {modalStrategyNodes.length > 0 && (
                <div className="strategy-steps-list">
                  {modalStrategyNodes.map((node, index) => {
                    const nodeData = node.data as NodeData;
                    return (
                      <div key={node.id} className="strategy-step-item">
                        <div className="strategy-step-number">{index + 1}</div>
                        <div className="strategy-step-content">
                          <div className="strategy-step-title">{nodeData?.label || `Step ${index + 1}`}</div>
                          <div className="strategy-step-details">
                            {nodeData?.type && (
                              <span className="strategy-step-type">{nodeData.type}</span>
                            )}
                            {nodeData?.chain && (
                              <span className="strategy-step-chain">{nodeData.chain}</span>
                            )}
                            {nodeData?.coin && (
                              <span className="strategy-step-coin">{nodeData.coin}</span>
                            )}
                            {nodeData?.toCoin && (
                              <span className="strategy-step-coin">→ {nodeData.toCoin}</span>
                            )}
                            {nodeData?.amount && (
                              <span className="strategy-step-amount">{nodeData.amount}</span>
                            )}
                            {nodeData?.strategy && (
                              <span className="strategy-step-strategy">{nodeData.strategy}</span>
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
          
          <div className="strategy-modal-preview">
            <h3 className="strategy-preview-title">Strategy Preview</h3>
            <div className="strategy-preview-flow">
              {isFlowLoading ? (
                <div className="strategy-preview-placeholder">
                  <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                  <p>Loading strategy preview...</p>
                </div>
              ) : modalStrategyNodes.length > 0 ? (
                <div ref={flowRef} style={{ width: '100%', height: '100%', minHeight: '400px', position: 'relative' }}>
                  <ReactFlowProvider key={flowKey}>
                    <ReactFlow
                      key={`flow-${flowKey}`}
                      nodes={modalStrategyNodes}
                      edges={modalStrategyEdges}
                      onInit={(instance) => {
                        reactFlowInstance.current = instance;
                        setTimeout(() => {
                          instance.fitView({ padding: 0.2, duration: 400 });
                        }, 100);
                      }}
                      nodeTypes={{
                        custom: ({ data }: { data: NodeData }) => {
                          const nodeData = data as NodeData;
                          const isStrategy = nodeData.type === 'strategy';
                          return (
                            <div 
                              className={`blueprint-custom-node ${isStrategy ? 'strategy-node' : ''}`} 
                              style={{ 
                                position: 'relative',
                                background: isStrategy ? 'rgba(255, 193, 7, 0.2)' : undefined,
                                border: isStrategy ? '1px solid rgba(255, 193, 7, 0.5)' : undefined
                              }}
                            >
                              <Handle type="target" position={Position.Left} style={{ background: 'rgba(255, 255, 255, 0.3)' }} />
                              <div className="node-content">
                                <div className="node-title">{nodeData.label}</div>
                                {nodeData.type === 'deposit' && nodeData.coin && (
                                  <div className="node-preview-info" style={{ fontSize: '10px', color: 'var(--build-ui-text-muted)', marginTop: '0.5rem' }}>
                                    {nodeData.coin} {nodeData.amount ? `- ${nodeData.amount}` : ''}
                                  </div>
                                )}
                                {nodeData.type === 'swap' && (
                                  <div className="node-preview-info" style={{ fontSize: '10px', color: 'var(--build-ui-text-muted)', marginTop: '0.5rem' }}>
                                    {nodeData.coin || 'From'} → {nodeData.toCoin || 'To'} {nodeData.amount ? `- ${nodeData.amount}` : ''}
                                  </div>
                                )}
                                {nodeData.type === 'withdraw' && (
                                  <div className="node-preview-info" style={{ fontSize: '10px', color: 'var(--build-ui-text-muted)', marginTop: '0.5rem' }}>
                                    {nodeData.coin || 'Coin'} {nodeData.amount ? `- ${nodeData.amount}` : ''}
                                  </div>
                                )}
                                {nodeData.type === 'strategy' && nodeData.strategy && (
                                  <div className="node-preview-info" style={{ fontSize: '10px', color: 'var(--build-ui-text-muted)', marginTop: '0.5rem' }}>
                                    {nodeData.strategy} {nodeData.coin ? `- ${nodeData.coin}` : ''} {nodeData.amount ? `- ${nodeData.amount}` : ''}
                                  </div>
                                )}
                                {nodeData.chain && (
                                  <div className="node-preview-info" style={{ fontSize: '9px', color: 'var(--build-ui-text-muted)', marginTop: '0.25rem' }}>
                                    {nodeData.chain}
                                  </div>
                                )}
                              </div>
                              <Handle type="source" position={Position.Right} style={{ background: 'rgba(255, 255, 255, 0.3)' }} />
                            </div>
                          );
                        }
                      }}
                      defaultEdgeOptions={{
                        style: { stroke: 'rgba(255, 255, 255, 0.3)', strokeWidth: 2 },
                        type: 'smoothstep'
                      }}
                      fitView
                      minZoom={0.3}
                      maxZoom={1.5}
                      nodesDraggable={false}
                      nodesConnectable={false}
                      elementsSelectable={false}
                      panOnDrag={true}
                      zoomOnScroll={true}
                      zoomOnPinch={true}
                      proOptions={{ hideAttribution: true }}
                    >
                      <Background color="rgba(255, 255, 255, 0.02)" gap={16} size={1} />
                    </ReactFlow>
                  </ReactFlowProvider>
                </div>
              ) : (
                <div className="strategy-preview-placeholder">
                  <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                  <p>No strategy preview available</p>
                </div>
              )}
            </div>
          </div>
        </div>
        
        <div className="strategy-modal-actions">
          {onRun && (
            <button 
              className="strategy-modal-btn strategy-modal-btn-run"
              onClick={onRun}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Run
            </button>
          )}
          {onFavorite && (
            <button 
              className={`strategy-modal-btn strategy-modal-btn-like ${isFavorite ? 'active' : ''}`}
              onClick={onFavorite}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill={isFavorite ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              {isFavorite ? 'Remove from Favourites' : 'Add to Favourites'}
            </button>
          )}
          {onEdit && (
            <button 
              className="strategy-modal-btn strategy-modal-btn-edit"
              onClick={onEdit}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

