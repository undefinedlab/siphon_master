"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { builderChainProfile, isDexActive } from "@/builder_agent/blocks";
import { readStoredHomeChainId } from "@/lib/chains/homeChains";
import { getSelectedChainId } from "@/lib/networks";
import "./BuildNodeContextMenu.css";

export interface BuildNodeContextMenuProps {
  x: number;
  y: number;
  nodeLabel?: string;
  isRepeatGroup?: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
  onAddInside?: (kind: "swap" | "strategy" | "withdraw", variant?: string) => void;
  onClose: () => void;
}

export default function BuildNodeContextMenu({
  x,
  y,
  nodeLabel,
  isRepeatGroup,
  onDelete,
  onDuplicate,
  onAddInside,
  onClose,
}: BuildNodeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [swapPickerOpen, setSwapPickerOpen] = useState(false);

  const chainProfile = useMemo(
    () =>
      builderChainProfile({
        chainId: getSelectedChainId(),
        homeChainId: readStoredHomeChainId(),
      }),
    [],
  );
  const swapDexes = chainProfile.swapDexes;
  const preferredDex = chainProfile.preferredDex;

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof globalThis.Node)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    const frame = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handlePointerDown, true);
      document.addEventListener("keydown", handleKeyDown);
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const addSwap = (dex?: string) => {
    onAddInside?.("swap", dex);
    onClose();
  };

  const menu = (
    <div
      ref={menuRef}
      className="build-node-context-menu"
      style={{ left: x, top: y }}
      role="menu"
      aria-label={nodeLabel ? `Actions for ${nodeLabel}` : "Block actions"}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {nodeLabel && (
        <div className="build-node-context-menu-label">{nodeLabel}</div>
      )}
      {isRepeatGroup && onAddInside && (
        <>
          <div className="build-node-context-menu-section">Add inside loop</div>
          {!swapPickerOpen ? (
            <button
              type="button"
              className="build-node-context-menu-item"
              role="menuitem"
              onClick={() => {
                if (swapDexes.length <= 1) {
                  addSwap(preferredDex || swapDexes[0]);
                  return;
                }
                setSwapPickerOpen(true);
              }}
            >
              Swap{swapDexes.length > 1 ? " ›" : ""}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="build-node-context-menu-item"
                role="menuitem"
                onClick={() => setSwapPickerOpen(false)}
              >
                ← Swap on
              </button>
              {swapDexes.map((dex) => {
                const active = isDexActive(dex, {
                  chainId: getSelectedChainId(),
                  homeChainId: readStoredHomeChainId(),
                });
                return (
                  <button
                    key={dex}
                    type="button"
                    className={`build-node-context-menu-item${!active ? " inactive" : ""}`}
                    role="menuitem"
                    disabled={!active}
                    onClick={() => {
                      if (!active) return;
                      addSwap(dex);
                    }}
                  >
                    {dex}
                  </button>
                );
              })}
            </>
          )}
          {!swapPickerOpen && (
            <>
              <button
                type="button"
                className="build-node-context-menu-item"
                role="menuitem"
                onClick={() => {
                  onAddInside("withdraw", "Base");
                  onClose();
                }}
              >
                Withdraw
              </button>
              <button
                type="button"
                className="build-node-context-menu-item"
                role="menuitem"
                onClick={() => {
                  onAddInside("strategy", "Limit Order");
                  onClose();
                }}
              >
                Limit Order
              </button>
              <button
                type="button"
                className="build-node-context-menu-item"
                role="menuitem"
                onClick={() => {
                  onAddInside("strategy", "Stop Loss");
                  onClose();
                }}
              >
                Stop Loss
              </button>
              <button
                type="button"
                className="build-node-context-menu-item"
                role="menuitem"
                onClick={() => {
                  onAddInside("strategy", "Take Profit");
                  onClose();
                }}
              >
                Take Profit
              </button>
            </>
          )}
        </>
      )}
      <button
        type="button"
        className="build-node-context-menu-item"
        role="menuitem"
        onClick={() => {
          onDuplicate();
          onClose();
        }}
      >
        Duplicate block
      </button>
      <button
        type="button"
        className="build-node-context-menu-item build-node-context-menu-item-danger"
        role="menuitem"
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        Delete block
      </button>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(menu, document.body);
}
