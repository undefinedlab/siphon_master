/**
 * Strategy note reservation — closes the withdrawal race.
 *
 * A strategy's input note stays UNSPENT on-chain until the strategy executes. In that window the
 * user could withdraw the same note via a normal withdrawal, leaving the strategy with no funds.
 * To prevent that we mark the spent commitment(s) `pending` on the note DB at submit; the
 * withdrawal path (generateZKData) only ever re-hydrates `spent === 'false'` notes, so a reserved
 * note is no longer offered. Transitions are reconciled against strategy status:
 *   EXECUTED                       → 'true'  (genuinely spent on-chain)
 *   FAILED / CANCELLED / EXPIRED   → 'false' (revert — give the input note back)
 *   ABORTED / PARTIALLY_EXECUTED   → 'false' (revert unfired input notes — see abort flow)
 *
 * NOTE: reverting the input note to spendable is only HALF of a correct abort/fail. A single-order
 * strategy's CHANGE note was written spendable at submit but is only minted on-chain when the
 * withdraw tx fires. If the strategy is aborted/failed that tx never fires, so that change note is
 * a PHANTOM and must ALSO be marked spent — otherwise input + phantom-change double-count. This
 * module only tracks INPUT commitments; the phantom-change invalidation lives in abortStrategy()
 * (which gets the change commitment from the executor), keyed off the strategy's newCommitment.
 */
import { Signer } from "ethers";
import { markCommitmentSpentDurable } from "./commitmentStore";

const RESERVED_KEY = (strategyId: string) => `siphon-reserved-${strategyId}`;

/** Reserve a strategy's input commitments: mark them `pending` + remember them for reconciliation. */
export async function reserveStrategyNotes(
  signer: Signer,
  strategyId: string,
  serverCommitmentIds: (string | null | undefined)[],
): Promise<void> {
  const ids = serverCommitmentIds.filter((x): x is string => !!x);
  if (!strategyId || ids.length === 0) return;
  try { localStorage.setItem(RESERVED_KEY(strategyId), JSON.stringify(ids)); } catch { /* quota */ }
  // Durable: a lost `pending` leaves the server saying `false` while local says `true`, so a
  // SECOND device counts the reserved note as spendable AND shows the strategy holding it — the
  // same funds in two balance buckets, and a planner free to pick a note the enclave has a proof for.
  await Promise.allSettled(ids.map((id) => markCommitmentSpentDurable(signer, id, "pending")));
}

/** Reconcile reserved notes against strategy statuses. Best-effort; safe to call repeatedly.
 * `change_commitment` (single-order phantom change note, from the executor) is invalidated
 * whenever the strategy reverts (didn't execute), fixing the input+phantom double-count. */
export async function reconcileReservedNotes(
  signer: Signer,
  strategies: { id: string; status: string; change_commitment?: string | null }[],
): Promise<void> {
  for (const s of strategies) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(RESERVED_KEY(s.id)); } catch { /* ignore */ }
    if (!raw) continue;

    const st = (s.status || "").toUpperCase();
    // EXECUTED → 'true' (spent on-chain). Every non-executing terminal state → 'false' to return
    // the unspent input note. ABORTED + PARTIALLY_EXECUTED included: their UNFIRED input notes are
    // never spent on-chain, so the reservation must be reverted. (Fired TWAP legs are handled
    // server-side — their slice-notes stay spent; this only reverts the reserved INPUT commitments.)
    const terminal: "true" | "false" | null =
      st === "EXECUTED" ? "true"
        : (st === "FAILED" || st === "CANCELLED" || st === "EXPIRED"
            || st === "ABORTED" || st === "PARTIALLY_EXECUTED" ? "false" : null);
    if (!terminal) continue;

    let ids: string[] = [];
    try { ids = JSON.parse(raw); } catch { ids = []; }
    // Durable for the mirror failure: a lost `false` leaves the server on `pending` forever, so
    // spent-wins excludes the note permanently and the user's returned funds never reappear.
    await Promise.allSettled(ids.map((id) => markCommitmentSpentDurable(signer, id, terminal)));
    try { localStorage.removeItem(RESERVED_KEY(s.id)); } catch { /* ignore */ }

    // The input notes were marked spent:true LOCALLY at submit to block the withdrawal race. If the
    // strategy didn't execute, return them to spendable (on-chain they're untouched). The server-
    // side markCommitmentSpent(..,'false') above is the backstop if this device misses this pass.
    if (terminal === "false") {
      try {
        const cleanupRaw = localStorage.getItem(`siphon-pending-cleanup-${s.id}`);
        if (cleanupRaw) {
          const localKeys: string[] = JSON.parse(cleanupRaw);
          const { markNoteSpent } = await import("./localNoteStore");
          for (const k of localKeys) markNoteSpent(k, false);
          localStorage.removeItem(`siphon-pending-cleanup-${s.id}`);
        }
      } catch { /* best-effort */ }

      // Invalidate the PHANTOM change note: on a non-executed terminal state the withdraw tx
      // never fired, so the change note the strategy would have minted was never created on-chain.
      // It was written spendable at submit, so without this it double-counts against the reverted
      // input note. Mark it spent in BOTH stores. (Single-order only — the executor sends null for
      // TWAP/grid, whose slices are real on-chain leaves.)
      if (s.change_commitment) {
        try {
          const { markCommitmentSpentByCommitment } = await import("./commitmentStore");
          await markCommitmentSpentByCommitment(signer, s.change_commitment);
          const { markNoteSpentByKey, scanAllNoteMeta } = await import("./localNoteStore");
          const key = scanAllNoteMeta().find((m) => m.commitment === s.change_commitment)?.key;
          if (key) markNoteSpentByKey(key, "true");
        } catch (e) {
          console.warn("[reconcile] phantom change-note invalidation failed:", s.id, e);
        }
      }
    }
  }
}
