"use client";

import { useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Node, Edge } from '@xyflow/react';
import { showAppToast } from "@/lib/appToast";
import "./BuildNav.css";
import { builderChainProfile } from "@/builder_agent/blocks";
import { readStoredHomeChainId } from "@/lib/chains/homeChains";
import { getSelectedChainId } from "@/lib/networks";
import {
  BRIDGE_DESTS,
  bridgeDestOptionLabel,
  bridgeDestsFrom,
  isBridgeVaultChain,
  vaultLabel,
} from "@/lib/bridge/hub";

type ActionCategory = 'wallet' | 'triggers' | 'control' | 'defi';
type WalletAction = 'deposit' | 'withdraw' | 'bridge';
type DefiAction = 'swap' | 'earn' | 'stake';
type MobilePicker =
  | ActionCategory
  | 'wallet-deposit'
  | 'wallet-withdraw'
  | 'wallet-bridge'
  | 'defi-swap'
  | 'defi-earn'
  | 'defi-stake'
  | null;

const CATEGORY_META: Record<ActionCategory, { label: string; icon: ReactNode }> = {
  wallet: {
    label: 'Wallet',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
        <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
      </svg>
    ),
  },
  triggers: {
    label: 'Triggers',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="2" />
      </svg>
    ),
  },
  control: {
    label: 'Control',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <line x1="4" y1="21" x2="4" y2="14" />
        <line x1="4" y1="10" x2="4" y2="3" />
        <line x1="12" y1="21" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12" y2="3" />
        <line x1="20" y1="21" x2="20" y2="16" />
        <line x1="20" y1="12" x2="20" y2="3" />
        <line x1="1" y1="14" x2="7" y2="14" />
        <line x1="9" y1="8" x2="15" y2="8" />
        <line x1="17" y1="16" x2="23" y2="16" />
      </svg>
    ),
  },
  defi: {
    label: 'DeFi',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M7 16V4m0 0L3 8m4-4 4 4" />
        <path d="M17 8v12m0 0 4-4m-4 4-4-4" />
      </svg>
    ),
  },
};

interface AddMenuState {
  step: "categories" | "category";
  category?: ActionCategory;
  walletAction?: WalletAction;
  defiAction?: DefiAction;
}

interface BuildNavProps {
  nodes: Node[];
  currentFileName: string;
  savedScenes: Array<{ name: string; nodes: Node[]; edges: Edge[] }>;
  onAddNode: (type: 'deposit' | 'withdraw' | 'swap' | 'lend' | 'strategy' | 'control' | 'bridge', chainOrDexOrStrategy?: string) => void;
  onSaveScene: (sceneName: string) => void;
  onLoadScene: (sceneName: string) => void;
  onDeleteScene: (sceneName: string) => void;
  onRestart: () => void;
  onSimulate: () => void;
  isSimulating?: boolean;
  onOpenRun: () => void;
  setCurrentFileName: (name: string) => void;
  hideAddControls?: boolean;
  /** When true, show save / open / run in the mid top bar (expanded chat / no widget band). */
  expandedToolbar?: boolean;
}

export default function BuildNav({
  nodes,
  currentFileName,
  savedScenes,
  onAddNode,
  onSaveScene,
  onLoadScene,
  onDeleteScene,
  onRestart,
  onSimulate,
  isSimulating = false,
  onOpenRun,
  setCurrentFileName,
  hideAddControls = false,
  expandedToolbar = false,
}: BuildNavProps) {
  const [addMenu, setAddMenu] = useState<AddMenuState | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [sceneName, setSceneName] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [mobilePicker, setMobilePicker] = useState<MobilePicker>(null);
  
  const addMenuRef = useRef<HTMLDivElement>(null);
  
  const strategies = ['Limit Order', 'Stop Loss', 'Take Profit'];
  const controls = ['Schedule', 'Loop', 'Price', 'Rules'];

  const [chainTick, setChainTick] = useState(0);
  useEffect(() => {
    const bump = () => setChainTick((n) => n + 1);
    window.addEventListener("siphon:chainChanged", bump);
    window.addEventListener("siphon:homeChainChanged", bump);
    return () => {
      window.removeEventListener("siphon:chainChanged", bump);
      window.removeEventListener("siphon:homeChainChanged", bump);
    };
  }, []);

  // Wallet nodes are created on the chain the dapp is on (re-read on every render, so opening the
  // add menu after a chain switch picks it up). Labels round-trip through CHAIN_LABEL_TO_ID.
  const vaultChainId = getSelectedChainId();
  const homeChainId = readStoredHomeChainId();
  const chainProfile = useMemo(
    () => builderChainProfile({ chainId: vaultChainId, homeChainId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vaultChainId, homeChainId, chainTick],
  );
  const swapDexes = chainProfile.swapDexes;
  const activeSwapDexes = chainProfile.activeSwapDexes;
  const isSolanaBuilder = chainProfile.kind === "solana";
  const isDexSelectable = (dex: string) =>
    activeSwapDexes.some((d) => d.toLowerCase() === dex.toLowerCase());
  const earnActions = [
    { label: 'Enter — USDC → jlUSDC', action: 'enter' as const },
    { label: 'Exit — jlUSDC → USDC', action: 'exit' as const },
  ];
  const stakeActions = [
    { label: 'Stake — SOL → JitoSOL', action: 'jito-enter' as const },
    { label: 'Unstake — JitoSOL → SOL', action: 'jito-exit' as const },
  ];
  const defiActions = [
    { label: 'Swap', active: true, node: 'swap' as const, submenu: true },
    // Jupiter Earn + Jito stake on Solana Devnet. Hidden on EVM — no venue yet.
    ...(isSolanaBuilder
      ? [
          { label: 'Earn (Jupiter)', active: true, node: 'lend' as const, submenu: true, defiKey: 'earn' as const },
          { label: 'Stake (Jito)', active: true, node: 'lend' as const, submenu: true, defiKey: 'stake' as const },
        ]
      : [{ label: 'Lend', active: false, node: 'lend' as const, submenu: false, defiKey: 'earn' as const }]),
    // Post-ramp Tempo steps (after Withdraw to Tempo) — not on-vault Uniswap / Solana DEXes.
    ...(!isSolanaBuilder
      ? [
          { label: 'Tempo DEX', active: true, node: 'tempo-dex' as const, submenu: false },
          { label: 'Tempo Zone', active: true, node: 'tempo-zone' as const, submenu: false },
        ]
      : []),
    { label: 'Borrow', active: false, node: 'swap' as const, submenu: false },
  ];
  const activeChain = vaultLabel(vaultChainId);
  // Deposits land in the home vault. On a bridge vault a withdrawal can also pay out to any LI.FI
  // destination — the executor bridges the order when it fires (hub.ts payoutDestFor).
  const chainsFor = (action?: string) =>
    action === "withdraw" && isBridgeVaultChain(vaultChainId)
      ? [activeChain, ...bridgeDestsFrom(vaultChainId).map((d) => d.label)]
      : [activeChain];
  
  useEffect(() => {
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest(".blueprint-add-menu-anchor")) return;
      setAddMenu(null);
    };

    if (addMenu) {
      document.addEventListener("pointerdown", handleOutsidePointerDown, true);
      return () => document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }
  }, [addMenu]);

  useEffect(() => {
    if (!expandedToolbar) setAddMenu(null);
  }, [expandedToolbar]);
  
  const addMenuTitle = (menu: AddMenuState) => {
    if (menu.step === "categories") return "Add node";
    if (menu.category === "wallet") {
      if (menu.walletAction === "deposit") return "Deposit";
      if (menu.walletAction === "withdraw") return "Withdraw to";
      if (menu.walletAction === "bridge") return "Bridge to vault";
      return "Wallet";
    }
    if (menu.category === "triggers") return "Triggers";
    if (menu.category === "control") return "Control";
    if (menu.category === "defi" && menu.defiAction === "swap") return "Swap on";
    if (menu.category === "defi" && menu.defiAction === "earn") return "Jupiter Earn";
    if (menu.category === "defi" && menu.defiAction === "stake") return "Jito Stake";
    return "DeFi";
  };

  const closeAddMenu = useCallback(() => setAddMenu(null), []);

  const onAddButtonClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) {
      setShowAddModal(true);
      return;
    }
    setAddMenu((current) => (current ? null : { step: "categories" }));
  }, []);
  
  const handleSaveScene = useCallback(() => {
    if (!sceneName.trim()) {
      showAppToast('Please enter a scene name', 'error');
      return;
    }
    
    onSaveScene(sceneName.trim());
    setCurrentFileName(`${sceneName.trim()}.io`);
    setShowSaveDialog(false);
    setSceneName('');
    
    setSaveSuccess(true);
    setTimeout(() => {
      setSaveSuccess(false);
    }, 1500);
  }, [sceneName, onSaveScene, setCurrentFileName]);
  
  const handleOpenScenesPicker = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setShowOpenModal(true);
  }, []);

  const handleLoadScene = useCallback((sceneName: string) => {
    onLoadScene(sceneName);
    setShowOpenModal(false);
  }, [onLoadScene]);

  const renderSavedScenesList = () => {
    if (savedScenes.length === 0) {
      return <div className="blueprint-scenes-picker-empty">No saved scenes</div>;
    }

    return savedScenes.map((scene) => (
      <div key={scene.name} className="blueprint-scene-item">
        <button
          type="button"
          className="blueprint-scene-load"
          onClick={(e) => {
            e.stopPropagation();
            handleLoadScene(scene.name);
          }}
        >
          {scene.name}
        </button>
        <button
          type="button"
          className="blueprint-scene-delete"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteScene(scene.name);
          }}
          title="Delete scene"
          aria-label={`Delete ${scene.name}`}
        >
          ×
        </button>
      </div>
    ));
  };

  const renderAddMenuPanel = () => {
    if (!addMenu) return null;

    return (
      <div
        ref={addMenuRef}
        className="blueprint-add-menu"
        role="menu"
        aria-label="Add node"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="blueprint-add-menu-header">
          {addMenu.step === "category" ? (
            <button
              type="button"
              className="blueprint-add-menu-back"
              onClick={(e) => {
                e.stopPropagation();
                if (addMenu.category === "wallet" && addMenu.walletAction) {
                  setAddMenu({ step: "category", category: "wallet" });
                  return;
                }
                if (addMenu.category === "defi" && addMenu.defiAction) {
                  setAddMenu({ step: "category", category: "defi" });
                  return;
                }
                setAddMenu({ step: "categories" });
              }}
            >
              ← Back
            </button>
          ) : null}
          <span>{addMenuTitle(addMenu)}</span>
        </div>

        {addMenu.step === "categories" &&
          (Object.keys(CATEGORY_META) as ActionCategory[]).map((category) => (
            <button
              key={category}
              type="button"
              role="menuitem"
              className={`blueprint-add-menu-item blueprint-add-menu-item--${category}`}
              onClick={(e) => {
                e.stopPropagation();
                setAddMenu({ step: "category", category });
              }}
            >
              <span className="blueprint-add-menu-item-icon">{CATEGORY_META[category].icon}</span>
              <span>{CATEGORY_META[category].label}</span>
            </button>
          ))}

        {addMenu.step === "category" && addMenu.category === "wallet" && !addMenu.walletAction && (
          <>
            <button
              type="button"
              className="blueprint-add-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                setAddMenu({ step: "category", category: "wallet", walletAction: "deposit" });
              }}
            >
              Deposit
            </button>
            <button
              type="button"
              className="blueprint-add-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                setAddMenu({ step: "category", category: "wallet", walletAction: "withdraw" });
              }}
            >
              Withdraw
            </button>
            <button
              type="button"
              className="blueprint-add-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                setAddMenu({ step: "category", category: "wallet", walletAction: "bridge" });
              }}
            >
              Bridge
            </button>
          </>
        )}

        {addMenu.step === "category" && addMenu.category === "wallet" && addMenu.walletAction &&
          (addMenu.walletAction === "bridge"
            ? ["Arbitrum", "Base"]
            : chainsFor(addMenu.walletAction)
          ).map((chain) => {
            const dest = BRIDGE_DESTS.find((d) => d.label === chain);
            const label =
              addMenu.walletAction === "withdraw" && dest
                ? bridgeDestOptionLabel(dest)
                : chain;
            return (
              <button
                key={chain}
                type="button"
                className="blueprint-add-menu-item"
                onClick={(e) => {
                  e.stopPropagation();
                  if (addMenu.walletAction === "bridge") {
                    onAddNode("bridge", chain);
                  } else {
                    onAddNode(addMenu.walletAction!, chain);
                  }
                  closeAddMenu();
                }}
              >
                {label}
              </button>
            );
          })}

        {addMenu.step === "category" && addMenu.category === "triggers" &&
          strategies.map((strategy) => (
            <button
              key={strategy}
              type="button"
              className="blueprint-add-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                onAddNode("strategy", strategy);
                closeAddMenu();
              }}
            >
              {strategy}
            </button>
          ))}

        {addMenu.step === "category" && addMenu.category === "control" &&
          controls.map((control) => (
            <button
              key={control}
              type="button"
              className="blueprint-add-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                onAddNode("control", control);
                closeAddMenu();
              }}
            >
              {control}
            </button>
          ))}

        {addMenu.step === "category" && addMenu.category === "defi" && !addMenu.defiAction &&
          defiActions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`blueprint-add-menu-item ${!action.active ? "inactive" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                if (!action.active) return;
                if (action.node === "tempo-dex" || action.node === "tempo-zone") {
                  onAddNode("control", action.node === "tempo-dex" ? "Tempo DEX" : "Tempo Zone");
                  closeAddMenu();
                  return;
                }
                if (action.node === "swap") {
                  // Only skip the venue picker when there's a single display option.
                  // On Solana we still open the submenu so inactive venues show greyed out.
                  if (swapDexes.length === 1) {
                    onAddNode("swap", activeSwapDexes[0] ?? swapDexes[0]);
                    closeAddMenu();
                    return;
                  }
                  setAddMenu({ step: "category", category: "defi", defiAction: "swap" });
                  return;
                }
                if (action.node === "lend") {
                  setAddMenu({
                    step: "category",
                    category: "defi",
                    defiAction: (action as { defiKey?: "earn" | "stake" }).defiKey === "stake" ? "stake" : "earn",
                  });
                  return;
                }
                closeAddMenu();
              }}
              disabled={!action.active}
            >
              {action.label}
              {(action.submenu && (action.node === "lend" || swapDexes.length > 1)) ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: "auto" }} aria-hidden>
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              ) : null}
            </button>
          ))}

        {addMenu.step === "category" && addMenu.category === "defi" && addMenu.defiAction === "swap" &&
          swapDexes.map((dex) => {
            const active = isDexSelectable(dex);
            return (
              <button
                key={dex}
                type="button"
                className={`blueprint-add-menu-item ${!active ? "inactive" : ""}`}
                disabled={!active}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!active) return;
                  onAddNode("swap", dex);
                  closeAddMenu();
                }}
              >
                {dex}
              </button>
            );
          })}

        {addMenu.step === "category" && addMenu.category === "defi" && addMenu.defiAction === "earn" &&
          earnActions.map((opt) => (
            <button
              key={opt.action}
              type="button"
              className="blueprint-add-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                onAddNode("lend", opt.action);
                closeAddMenu();
              }}
            >
              {opt.label}
            </button>
          ))}

        {addMenu.step === "category" && addMenu.category === "defi" && addMenu.defiAction === "stake" &&
          stakeActions.map((opt) => (
            <button
              key={opt.action}
              type="button"
              className="blueprint-add-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                onAddNode("lend", opt.action);
                closeAddMenu();
              }}
            >
              {opt.label}
            </button>
          ))}
      </div>
    );
  };

  const addButton =
    !hideAddControls && expandedToolbar ? (
      <div className="blueprint-add-menu-anchor">
        <button
          type="button"
          className={`blueprint-add-btn blueprint-add-btn--icon${addMenu ? " blueprint-add-btn--active" : ""}`}
          onClick={onAddButtonClick}
          title="Add node"
          aria-label="Add node"
          aria-expanded={Boolean(addMenu)}
          aria-haspopup="menu"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        {renderAddMenuPanel()}
      </div>
    ) : null;

  return (
    <>
      <div
        className={`blueprint-top-bar blueprint-top-bar--mid blueprint-top-bar--expanded${
          expandedToolbar ? " blueprint-top-bar--visible" : ""
        }`}
        aria-hidden={!expandedToolbar}
      >
        <div className="blueprint-toolbar-end blueprint-toolbar-end--scene">
          <div className="blueprint-file-group">
            <button
              type="button"
              className="blueprint-icon-btn blueprint-folder-btn"
              onClick={handleOpenScenesPicker}
              title="Open saved scene"
              aria-label="Open saved scene"
              aria-haspopup="dialog"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <input
              type="text"
              className="blueprint-file-name-input"
              value={currentFileName}
              onChange={(e) => setCurrentFileName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              spellCheck={false}
              aria-label="Scene file name"
            />
          </div>
          <button
            type="button"
            className={`blueprint-save-btn blueprint-save-btn--labeled ${saveSuccess ? 'save-success' : ''}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (nodes.length > 0 && !saveSuccess) {
                setShowSaveDialog(true);
              }
            }}
            disabled={nodes.length === 0 || saveSuccess}
            title="Save scene"
          >
            {saveSuccess ? (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="checkmark-icon">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span className="blueprint-toolbar-label">Saved</span>
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                <span className="blueprint-toolbar-label">Save</span>
              </>
            )}
          </button>
          <button
            type="button"
            className="blueprint-run-btn blueprint-run-btn--labeled"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (nodes.length > 0) {
                onOpenRun();
              }
            }}
            disabled={nodes.length === 0}
            title="Run strategy"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            <span className="blueprint-toolbar-label">Run</span>
          </button>
          <button
            type="button"
            className="blueprint-execute-btn blueprint-execute-btn--labeled"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (nodes.length > 0) {
                onSimulate();
              }
            }}
            disabled={nodes.length === 0 || isSimulating}
            title="Smoke test strategy"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            <span className="blueprint-toolbar-label">{isSimulating ? "Smoking" : "Smoke"}</span>
          </button>
          <button
            type="button"
            className="blueprint-restart-btn blueprint-restart-btn--icon"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (nodes.length > 0) {
                onRestart();
              }
            }}
            disabled={nodes.length === 0}
            title="Reset canvas"
            aria-label="Reset canvas"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
          </button>
          {addButton ? (
            <>
              <span className="blueprint-toolbar-sep" aria-hidden="true" />
              {addButton}
            </>
          ) : null}
        </div>
      </div>

      {showSaveDialog && (
        <div className="blueprint-save-dialog-overlay" onClick={(e) => {
          e.stopPropagation();
          setShowSaveDialog(false);
          setSceneName('');
        }}>
          <div className="blueprint-save-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="blueprint-save-dialog-header">
              <h3>Save Scene</h3>
              <button 
                className="blueprint-save-dialog-close"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowSaveDialog(false);
                  setSceneName('');
                }}
              >
                ×
              </button>
            </div>
            <div className="blueprint-save-dialog-content">
              <input
                type="text"
                className="blueprint-save-dialog-input"
                placeholder="Enter scene name"
                value={sceneName}
                onChange={(e) => setSceneName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation();
                    handleSaveScene();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                autoFocus
              />
            </div>
            <div className="blueprint-save-dialog-actions">
              <button 
                className="blueprint-save-dialog-cancel"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowSaveDialog(false);
                  setSceneName('');
                }}
              >
                Cancel
              </button>
              <button 
                className="blueprint-save-dialog-save"
                onClick={(e) => {
                  e.stopPropagation();
                  handleSaveScene();
                }}
                disabled={!sceneName.trim()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile: Add Node Fullscreen Modal */}
      {!hideAddControls && showAddModal && (
        <div className="blueprint-mobile-modal-overlay" onClick={(e) => {
          e.stopPropagation();
          setShowAddModal(false);
          setMobilePicker(null);
        }}>
          <div className="blueprint-mobile-modal" onClick={(e) => e.stopPropagation()}>
            <div className="blueprint-mobile-modal-header">
              <h3>{!mobilePicker ? 'Add Node' :
                mobilePicker === 'wallet' ? 'Wallet:' :
                mobilePicker === 'wallet-deposit' ? 'Deposit:' :
                mobilePicker === 'wallet-withdraw' ? 'Withdraw to:' :
                mobilePicker === 'wallet-bridge' ? 'Bridge to vault:' :
                mobilePicker === 'triggers' ? 'Triggers:' :
                mobilePicker === 'control' ? 'Control:' :
                mobilePicker === 'defi-swap' ? 'Swap on:' :
                mobilePicker === 'defi-earn' ? 'Jupiter Earn:' : 'DeFi:'}</h3>
              <button 
                className="blueprint-mobile-modal-close"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAddModal(false);
                  setMobilePicker(null);
                }}
              >
                ×
              </button>
            </div>
            <div className="blueprint-mobile-modal-content">
              {!mobilePicker ? (
                <>
                  {(['wallet', 'triggers', 'control', 'defi'] as ActionCategory[]).map((cat) => (
                    <button
                      key={cat}
                      className={`blueprint-mobile-modal-btn blueprint-mobile-modal-btn--${cat}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMobilePicker(cat);
                      }}
                    >
                      <span className="blueprint-mobile-modal-btn-icon">{CATEGORY_META[cat].icon}</span>
                      <span>{CATEGORY_META[cat].label}</span>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto' }}>
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </button>
                  ))}
                </>
              ) : (
                <>
                  <button 
                    className="blueprint-mobile-modal-back-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (mobilePicker === 'wallet-deposit' || mobilePicker === 'wallet-withdraw' || mobilePicker === 'wallet-bridge') {
                        setMobilePicker('wallet');
                      } else if (mobilePicker === 'defi-swap' || mobilePicker === 'defi-earn') {
                        setMobilePicker('defi');
                      } else {
                        setMobilePicker(null);
                      }
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                    <span>Back</span>
                  </button>
                  {mobilePicker === 'wallet' && (
                    <>
                      <button className="blueprint-mobile-modal-btn" onClick={(e) => { e.stopPropagation(); setMobilePicker('wallet-deposit'); }}>
                        <span>Deposit</span>
                      </button>
                      <button className="blueprint-mobile-modal-btn" onClick={(e) => { e.stopPropagation(); setMobilePicker('wallet-withdraw'); }}>
                        <span>Withdraw</span>
                      </button>
                      <button className="blueprint-mobile-modal-btn" onClick={(e) => { e.stopPropagation(); setMobilePicker('wallet-bridge'); }}>
                        <span>Bridge</span>
                      </button>
                    </>
                  )}
                  {(mobilePicker === 'wallet-deposit' || mobilePicker === 'wallet-withdraw') && (
                    chainsFor(mobilePicker === 'wallet-deposit' ? 'deposit' : 'withdraw').map((chain) => {
                      const walletType = mobilePicker === 'wallet-deposit' ? 'deposit' : 'withdraw';
                      const dest = BRIDGE_DESTS.find((d) => d.label === chain);
                      const label =
                        walletType === "withdraw" && dest ? bridgeDestOptionLabel(dest) : chain;
                      return (
                        <button
                          key={chain}
                          className="blueprint-mobile-modal-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onAddNode(walletType, chain);
                            setShowAddModal(false);
                            setMobilePicker(null);
                          }}
                        >
                          <span>{label}</span>
                        </button>
                      );
                    })
                  )}
                  {mobilePicker === 'wallet-bridge' &&
                    ["Arbitrum", "Base"].map((chain) => (
                      <button
                        key={chain}
                        className="blueprint-mobile-modal-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddNode("bridge", chain);
                          setShowAddModal(false);
                          setMobilePicker(null);
                        }}
                      >
                        <span>{chain}</span>
                      </button>
                    ))}
                  {mobilePicker === 'triggers' && strategies.map((strategy) => (
                    <button
                      key={strategy}
                      className="blueprint-mobile-modal-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddNode('strategy', strategy);
                        setShowAddModal(false);
                        setMobilePicker(null);
                      }}
                    >
                      <span>{strategy}</span>
                    </button>
                  ))}
                  {mobilePicker === 'control' && controls.map((control) => (
                    <button
                      key={control}
                      className="blueprint-mobile-modal-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddNode('control', control);
                        setShowAddModal(false);
                        setMobilePicker(null);
                      }}
                    >
                      <span>{control}</span>
                    </button>
                  ))}
                  {mobilePicker === 'defi' && defiActions.map((action) => (
                    <button
                      key={action.label}
                      className={`blueprint-mobile-modal-btn ${!action.active ? 'inactive' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!action.active) return;
                        if (action.node === 'tempo-dex' || action.node === 'tempo-zone') {
                          onAddNode('control', action.node === 'tempo-dex' ? 'Tempo DEX' : 'Tempo Zone');
                          setShowAddModal(false);
                          setMobilePicker(null);
                          return;
                        }
                        if (action.node === 'swap') {
                          if (swapDexes.length === 1) {
                            onAddNode('swap', activeSwapDexes[0] ?? swapDexes[0]);
                            setShowAddModal(false);
                            setMobilePicker(null);
                            return;
                          }
                          setMobilePicker('defi-swap');
                          return;
                        }
                        if (action.node === 'lend') {
                          setMobilePicker(
                            (action as { defiKey?: 'earn' | 'stake' }).defiKey === 'stake'
                              ? 'defi-stake'
                              : 'defi-earn',
                          );
                          return;
                        }
                        setShowAddModal(false);
                        setMobilePicker(null);
                      }}
                      disabled={!action.active}
                    >
                      <span>{action.label}</span>
                      {(action.submenu && (action.node === 'lend' || swapDexes.length > 1)) ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto' }} aria-hidden>
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      ) : null}
                    </button>
                  ))}
                  {mobilePicker === 'defi-earn' && earnActions.map((opt) => (
                    <button
                      key={opt.action}
                      className="blueprint-mobile-modal-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddNode('lend', opt.action);
                        setShowAddModal(false);
                        setMobilePicker(null);
                      }}
                    >
                      <span>{opt.label}</span>
                    </button>
                  ))}
                  {mobilePicker === 'defi-stake' && stakeActions.map((opt) => (
                    <button
                      key={opt.action}
                      className="blueprint-mobile-modal-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddNode('lend', opt.action);
                        setShowAddModal(false);
                        setMobilePicker(null);
                      }}
                    >
                      <span>{opt.label}</span>
                    </button>
                  ))}
                  {mobilePicker === 'defi-swap' && swapDexes.map((dex) => {
                    const active = isDexSelectable(dex);
                    return (
                      <button
                        key={dex}
                        className={`blueprint-mobile-modal-btn ${!active ? 'inactive' : ''}`}
                        disabled={!active}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!active) return;
                          onAddNode('swap', dex);
                          setShowAddModal(false);
                          setMobilePicker(null);
                        }}
                      >
                        <span>{dex}</span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showOpenModal && (
        <div
          className="blueprint-scenes-picker-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Open saved scene"
          onClick={(e) => {
            e.stopPropagation();
            setShowOpenModal(false);
          }}
        >
          <div className="blueprint-scenes-picker" onClick={(e) => e.stopPropagation()}>
            <div className="blueprint-scenes-picker-header">
              <h3>Saved scenes</h3>
              <button
                type="button"
                className="blueprint-scenes-picker-close"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowOpenModal(false);
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="blueprint-scenes-picker-list">{renderSavedScenesList()}</div>
          </div>
        </div>
      )}
    </>
  );
}
