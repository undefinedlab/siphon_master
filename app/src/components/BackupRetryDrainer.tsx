"use client";

/**
 * Drain the note-backup retry queue on the events that actually correlate with connectivity
 * returning — not only when some other flow happens to run a sync.
 *
 * WHY. A deposit whose Supabase write fails is kept as `backup:'pending'` and queued
 * (`siphon-backup-pending-<chain>`). The queue was drained ONLY from inside `syncFromServer` /
 * `syncV3FromServer`, so a user who deposited during a blip and did not return to a screen that
 * syncs kept a note that exists nowhere but this browser. Supabase is the durable recovery source,
 * so "local only" is one cleared browser away from losing the note entirely.
 *
 * Triggers are deliberately connectivity-shaped: wallet connect, tab becoming visible, and the
 * browser's own `online` event. Each is a moment when a previously-failing write plausibly starts
 * working — unlike a timer, which mostly retries into the same failure.
 *
 * Cheap when idle: `drainBackupRetryQueue` reads one localStorage key and returns immediately when
 * the queue is empty, so a fired trigger with nothing pending costs a JSON parse.
 */

import { useEffect } from "react";

import { getSigner } from "@/lib/nexus";
import { hasCompletedOnboarding } from "@/lib/onboarding";

/** Chains whose queues we drain. Keys are per-chain, and a queue for a chain the user is not on is
 *  still worth flushing — the note is just as undurable either way. */
function chainsToDrain(): number[] {
  const ids = new Set<number>();
  for (const raw of [
    process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID,
    process.env.NEXT_PUBLIC_V3_SEPOLIA_CHAIN_ID,
  ]) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) ids.add(n);
  }
  // Discover any other chain that actually has a pending queue, so a note is never stranded just
  // because its chain is not in the env.
  if (typeof localStorage !== "undefined") {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      for (const prefix of ["siphon-backup-pending-", "siphon-spent-pending-"]) {
        if (!k?.startsWith(prefix)) continue;
        const n = Number(k.slice(prefix.length));
        if (Number.isFinite(n) && n > 0) ids.add(n);
      }
    }
  }
  return [...ids];
}

export default function BackupRetryDrainer() {
  useEffect(() => {
    let running = false;

    const drain = async () => {
      // One drain at a time: the triggers overlap (connect often fires alongside visibility), and
      // two concurrent drains would POST the same queued note twice — which, with no upsert on the
      // Supabase side, is a permanent duplicate row rather than a harmless retry.
      if (running) return;

      // Not until onboarding is done. This mounts from the root providers, and draining needs the
      // ENC-KEY — a wallet signature — so it put a 'Siphon-Encryption-Key-v1' prompt over the
      // welcome guide before the user had done anything. A pathname check does NOT catch that: the
      // guide renders AT /dapp rather than on its own route. hasCompletedOnboarding is the flag the
      // guide sets, so it is the only reliable signal here.
      //
      // The queue is durable in localStorage, so deferring costs nothing — the visibility and
      // connect triggers re-fire once the user is actually in the app.
      if (!hasCompletedOnboarding()) return;

      const signer = getSigner();
      if (!signer) return;
      running = true;
      try {
        const { drainBackupRetryQueue, drainSpentUpdateQueue } = await import(
          "@/lib/commitmentStore"
        );
        for (const chainId of chainsToDrain()) {
          try {
            const n = await drainBackupRetryQueue(signer, chainId);
            if (n > 0) console.log(`[backup] drained ${n} pending note backup(s) on chain ${chainId}`);
          } catch {
            /* per-chain: one failure must not skip the others */
          }
          try {
            // Spent-flag updates diverge the two stores when they fail, which is what lets the same
            // funds appear in two balance buckets on a second device.
            const m = await drainSpentUpdateQueue(signer, chainId);
            if (m > 0) console.log(`[spent] drained ${m} pending status update(s) on chain ${chainId}`);
          } catch {
            /* per-chain */
          }
        }
      } finally {
        running = false;
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void drain();
    };

    void drain();
    window.addEventListener("walletConnected", drain);
    window.addEventListener("online", drain);
    // Onboarding gates this drain (see above), and dismissing the guide fires none of the other
    // triggers — without this the queue would idle until the next reconnect or tab switch.
    window.addEventListener("siphon:onboardingComplete", drain);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.removeEventListener("walletConnected", drain);
      window.removeEventListener("siphon:onboardingComplete", drain);
      window.removeEventListener("online", drain);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
