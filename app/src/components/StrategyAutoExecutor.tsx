"use client";

/**
 * Background watcher: while the dapp is open, polls ARMED strategies and authorizes execution
 * via browser-side FHE decrypt. Disabled when TEE autonomous mode is on — the confidential VM
 * decrypts and the scheduler executes server-side.
 */

import { useCallback, useEffect, useRef } from "react";
import { processArmedStrategies } from "@/lib/strategyApi";
import { resolveWalletAddress } from "@/lib/walletAddress";
import { isTeeAutonomousMode } from "@/lib/decryptorClient";
import { getSigner } from "@/lib/nexus";
import { resolvePendingOutputNotes } from "@/lib/outputNoteResolver";

const POLL_MS = 5_000;

export default function StrategyAutoExecutor() {
  const teeMode = isTeeAutonomousMode();
  const inFlight = useRef(false);
  const notified = useRef(new Set<string>());

  const tick = useCallback(async () => {
    if (teeMode || inFlight.current) return;

    const userId = resolveWalletAddress();
    if (!userId) return;

    inFlight.current = true;
    try {
      const executed = await processArmedStrategies(userId);
      for (const id of executed) {
        if (notified.current.has(id)) continue;
        notified.current.add(id);
        console.log(`[AutoExecutor] Strategy ${id} executed automatically`);
        window.dispatchEvent(
          new CustomEvent("siphon:strategyExecuted", { detail: { strategyId: id } }),
        );
      }
    } catch (e) {
      console.error("[AutoExecutor]", e);
    } finally {
      inFlight.current = false;
    }
  }, [teeMode]);

  useEffect(() => {
    if (teeMode) return;
    void tick();
    const interval = setInterval(() => void tick(), POLL_MS);
    const onWake = () => void tick();

    const onExecuted = (e: Event) => {
      const strategyId = (e as CustomEvent<{ strategyId: string }>).detail?.strategyId;

      // Clean up spent input notes deferred from submission time.
      if (strategyId) {
        try {
          const cleanupKey = `siphon-pending-cleanup-${strategyId}`;
          const raw = localStorage.getItem(cleanupKey);
          if (raw) {
            const keys: string[] = JSON.parse(raw);
            for (const k of keys) { try { localStorage.removeItem(k); } catch {} }
            localStorage.removeItem(cleanupKey);
          }
        } catch { /* non-critical */ }
      }

      // Resolve vault-mode output notes now that on-chain deposit has landed.
      resolvePendingOutputNotes(getSigner()).catch(() => { /* best-effort */ });
    };

    window.addEventListener("walletConnected", onWake);
    window.addEventListener("siphon:strategySubmitted", onWake);
    window.addEventListener("siphon:strategyExecuted", onExecuted);
    return () => {
      clearInterval(interval);
      window.removeEventListener("walletConnected", onWake);
      window.removeEventListener("siphon:strategySubmitted", onWake);
      window.removeEventListener("siphon:strategyExecuted", onExecuted);
    };
  }, [tick, teeMode]);

  if (teeMode) return null;

  return null;
}
