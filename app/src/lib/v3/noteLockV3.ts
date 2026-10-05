/**
 * Per-note lock between strategy arming and ragequit.
 *
 * Both spend the same deposit note and the kernel's nullifier set lets only one land, so the money
 * is never at risk — the strategy is. Ragequit's exit ticket REVOKES the note's label before its own
 * transaction, so an arm that consumes the note in between leaves slices under a revoked label that
 * can never fire. An exact-size limit order is worse: its note stays unspent until the order fires,
 * so a ragequit minutes after arming still finds it.
 *
 * localStorage so every tab sees it. Arm locks outlive the five-minute ragequit window (after which
 * the ASP refuses an exit ticket anyway); ragequit locks are released when it finishes. Both expire
 * on their own if the tab dies.
 */
// ponytail: check-then-set across tabs is not atomic (a ms window); navigator.locks if that ever bites.

export type NoteLockHolder = "arm" | "ragequit";

/** The ragequit grace window, plus an arm that waits out the admit bus first. */
export const ARM_LOCK_MS = 15 * 60_000;
/** Exit ticket, the wait for its revoked root, the proof and the transaction. */
export const RAGEQUIT_LOCK_MS = 10 * 60_000;

const key = (commitment: string) => `siphon-note-lock-${commitment}`;

// Ragequit errors go through friendlyTxError, which keeps the text before any "(" and 140 chars.
const LOCKED_MSG: Record<NoteLockHolder, string> = {
  arm: "This deposit is funding a strategy you are arming or just armed. Ragequit would revoke it and kill that strategy.",
  ragequit: "This note is being ragequit right now. Try again in a minute.",
};

export function noteLockHolder(commitment: string, nowMs = Date.now()): NoteLockHolder | null {
  try {
    const raw = localStorage.getItem(key(commitment));
    if (!raw) return null;
    const { by, until } = JSON.parse(raw) as { by: NoteLockHolder; until: number };
    return until > nowMs ? by : null;
  } catch {
    return null;
  }
}

/** Take (or refresh) the lock for `by`; throws while the other side holds it. */
export function lockNote(commitment: string, by: NoteLockHolder, ttlMs: number, nowMs = Date.now()): void {
  const held = noteLockHolder(commitment, nowMs);
  if (held && held !== by) throw new Error(LOCKED_MSG[held]);
  try {
    localStorage.setItem(key(commitment), JSON.stringify({ by, until: nowMs + ttlMs }));
  } catch {
    /* no storage (private window): run unlocked, as before */
  }
}

export function unlockNote(commitment: string, by: NoteLockHolder): void {
  if (noteLockHolder(commitment) !== by) return;
  try {
    localStorage.removeItem(key(commitment));
  } catch {
    /* ignore */
  }
}
