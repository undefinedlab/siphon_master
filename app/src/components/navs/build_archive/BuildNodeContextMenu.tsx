"use client";

import { useEffect, useRef } from "react";
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

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="build-node-context-menu"
      style={{ left: x, top: y }}
      role="menu"
      aria-label={nodeLabel ? `Actions for ${nodeLabel}` : "Block actions"}
    >
      {nodeLabel && (
        <div className="build-node-context-menu-label">{nodeLabel}</div>
      )}
      {isRepeatGroup && onAddInside && (
        <>
          <div className="build-node-context-menu-section">Add inside loop</div>
          <button
            type="button"
            className="build-node-context-menu-item"
            role="menuitem"
            onClick={() => {
              onAddInside("swap");
              onClose();
            }}
          >
            Swap
          </button>
          <button
            type="button"
            className="build-node-context-menu-item"
            role="menuitem"
            onClick={() => {
              onAddInside("withdraw", "Sepolia");
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
}
