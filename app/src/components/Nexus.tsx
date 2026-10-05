"use client";

import { useState, useEffect, startTransition } from "react";
import { useNodesState, useEdgesState, Node, Edge } from '@xyflow/react';
import Build from "./navs/Builder/Build";
import Run from "./navs/Run/Run";
import UserDash from "./navs/UserDash/UserDash";
import { walletManager } from "./extensions/walletManager";

interface NexusProps {
  isLoaded?: boolean;
}

export default function Nexus({
  isLoaded = true
}: NexusProps) {
  const [viewMode, setViewMode] = useState<'blueprint' | 'run' | 'discover' | 'userdash' | 'markets'>('blueprint');
  const [runningStrategies, setRunningStrategies] = useState<Map<string, { startTime: number; isRunning: boolean; loop: boolean }>>(new Map());
  const [savedScenes, setSavedScenes] = useState<Array<{ name: string; nodes: Node[]; edges: Edge[] }>>([]);
  const [currentFileName, setCurrentFileName] = useState<string>('untitled.io');
  const [favoriteStrategies, setFavoriteStrategies] = useState<Set<string>>(new Set());
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [walletConnected, setWalletConnected] = useState(false);
  
  // React Flow state
  const initialNodes: Node[] = [];
  const [nodes, setNodes] = useNodesState(initialNodes);
  const [edges, setEdges] = useEdgesState<Edge>([]);

  useEffect(() => {
    const syncWalletState = async () => {
      const restored = await walletManager.restorePersistedSession();
      setWalletConnected(Boolean(restored ?? walletManager.getPrimaryWallet()));
    };

    void syncWalletState();

    const handleWalletConnected = () => {
      setWalletConnected(walletManager.hasActiveSession());
    };
    const handleWalletDisconnected = () => setWalletConnected(false);

    window.addEventListener('walletConnected', handleWalletConnected);
    window.addEventListener('walletDisconnected', handleWalletDisconnected);

    return () => {
      window.removeEventListener('walletConnected', handleWalletConnected);
      window.removeEventListener('walletDisconnected', handleWalletDisconnected);
    };
  }, []);

  // Listen for view mode changes from Nav component or balance click
  useEffect(() => {
    const handleViewModeChange = (event: CustomEvent) => {
      const mode = event.detail as 'blueprint' | 'run' | 'discover' | 'userdash' | 'markets';
      // Mark the view switch as a non-urgent transition so the click can paint immediately.
      // Switching to 'userdash' mounts the whole dashboard (strategy list, balance scan, note
      // reconciliation) synchronously; without this that render blocks the interaction (the INP
      // warning on .wallet-info-block). startTransition lets React render it off the critical path.
      startTransition(() => {
        if (mode === 'discover' || mode === 'markets') {
          setViewMode('blueprint');
          return;
        }
        setViewMode(mode);
      });
    };

    window.addEventListener('pro-view-mode-change', handleViewModeChange as EventListener);
    window.addEventListener('userdash-view-change', handleViewModeChange as EventListener);
    return () => {
      window.removeEventListener('pro-view-mode-change', handleViewModeChange as EventListener);
      window.removeEventListener('userdash-view-change', handleViewModeChange as EventListener);
    };
  }, []);

  // Load favorites from localStorage on mount
  useEffect(() => {
    const favorites = localStorage.getItem('siphon-favorite-strategies');
    if (favorites) {
      try {
        setFavoriteStrategies(new Set(JSON.parse(favorites)));
      } catch (error) {
        console.error('Failed to load favorites:', error);
      }
    }
  }, []);

  const isUserDash = viewMode === "userdash";

  return (
    <div
      className={`pro-mode-wrapper${isUserDash ? " pro-mode-wrapper--userdash" : ""}`}
      style={
        isUserDash
          ? {
              // Fill the scroll pane under the nav (opaque), grow with content for scroll.
              // Only this outer wrapper uses minHeight — nested 100% chains create a blank
              // extra viewport and let the hero peek through.
              display: "block",
              width: "100%",
              minHeight: "100%",
              height: "auto",
              maxHeight: "none",
              overflow: "visible",
              boxSizing: "border-box",
            }
          : {
              height: "100%",
              maxHeight: "100dvh",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }
      }
    >
      <div
        className={`pro-mode-content${isUserDash ? " pro-mode-content--userdash" : ""}`}
        style={{
          paddingTop: viewMode === "blueprint" ? "0" : isUserDash ? "0.75rem" : "2rem",
          height: isUserDash ? "auto" : "100%",
          overflowY: isUserDash ? "visible" : "hidden",
          overflowX: "hidden",
          display: isUserDash ? "block" : "flex",
          flexDirection: isUserDash ? undefined : "column",
        }}
      >
        {viewMode === 'run' ? (
          <Run
            isLoaded={isLoaded}
            savedScenes={savedScenes}
            setSavedScenes={setSavedScenes}
            favoriteStrategies={favoriteStrategies}
            showFavoritesOnly={showFavoritesOnly}
            setShowFavoritesOnly={setShowFavoritesOnly}
            runningStrategies={runningStrategies}
            setRunningStrategies={setRunningStrategies}
            setNodes={setNodes}
            setEdges={setEdges}
            setCurrentFileName={setCurrentFileName}
            setViewMode={setViewMode}
          />
        ) : viewMode === 'userdash' ? (
          <UserDash
            isLoaded={isLoaded}
            walletConnected={walletConnected}
          />
        ) : (
          <Build
            isLoaded={isLoaded}
            nodes={nodes}
            edges={edges}
            setNodes={setNodes}
            setEdges={setEdges}
            currentFileName={currentFileName}
            setCurrentFileName={setCurrentFileName}
            savedScenes={savedScenes}
            setSavedScenes={setSavedScenes}
            setViewMode={setViewMode}
            runningStrategies={runningStrategies}
            setRunningStrategies={setRunningStrategies}
          />
        )}
      </div>
    </div>
  );
}

